# Cross-tab agent messaging

## Status

Proposed.

This plan adds durable, provider-neutral messaging between addressable agent
tabs. A sender and recipient may be in different panes, inactive environments,
or different projects. Delivery must continue while the renderer is unmounted,
survive a backend restart, and recover without running a message twice.

This is not an extension of the current agent handoff feature. A handoff copies
a bounded conversation into a newly created tab and is then consumed. Messaging
is an ongoing mailbox between existing tab identities; it transfers only the
text the sender intentionally puts in one message.

## Product contract

The first complete version should provide all of the following:

1. An agent can discover addressable agent tabs throughout the application.
2. It can send bounded Markdown text to one exact destination, including a tab
   in another environment or project.
3. The accepted message is durable before the send call succeeds.
4. A recipient can read and acknowledge its mailbox through agent tools.
5. When automatic delivery is enabled for the destination, an idle recipient is
   woken through its normal prompt-dispatch path. A busy, stopped, or detached
   recipient retains the message until a safe delivery boundary exists.
6. The recipient can reply without rediscovering the source. Replies form a
   thread but do not automatically forward ordinary assistant output.
7. The UI shows sent, queued, submitted, acknowledged, and undeliverable states,
   plus unread counts at tab, environment, and project level.
8. Switching environments, closing the visible React tree, reconnecting another
   client, or restarting the backend cannot lose accepted messages or status.

The system is single-recipient in the first version. An agent that wants a
broadcast sends separate idempotent messages to explicit endpoints. This keeps
authorization, backpressure, delivery status, and retry behavior unambiguous.

## Terminology

- **Endpoint** — one durable, addressable agent tab incarnation. It is not a
  provider session ID and is not reused when a tab is recreated.
- **Mailbox** — the backend-owned incoming and outgoing message records for an
  endpoint.
- **Submitted** — the destination provider accepted the message prompt. This
  does not claim the model read or acted on it.
- **Acknowledged** — the recipient explicitly acknowledged or replied to the
  message through an agent tool.
- **User-seen** — a separate UI receipt. Opening an inbox does not claim the
  recipient agent processed the message.
- **Automatic delivery** — conversion of queued mailbox records into a normal,
  exactly-once prompt at a safe recipient boundary.

## Current architecture to extend

The useful existing pieces are:

- Tabs are durably represented in environment-owned pane layouts. Their current
  logical agent session key is `env-<environmentId>:<tabId>`.
- The backend owns persistent state through `StorageService`; committed writes
  raise body-free `resource-changed` announcements.
- Gateway events have bounded replay and an explicit reconciliation path.
- The renderer rehydrates pane layouts, sessions, prompt queues, and other
  stores from authoritative snapshots after mount and reconnect.
- `AgentToolsServer` already gives agents an environment/project-scoped MCP
  connection. It currently exposes Kanban tools and is the right agent-facing
  surface for messaging.
- Native and Claude tmux prompts already have durable queues, dispatch fences,
  idempotency keys, claim recovery, and backend drainers.
- Agent handoffs already demonstrate safe JSON carrier escaping and rendering
  of provider transcript content without trusting persisted bootstrap text.

The important gaps are:

- `(environmentId, tabId)` identifies a layout slot but not an immutable tab
  incarnation. Stable IDs such as `startup-agent` can be reused.
- The agent-tools credential identifies an environment, not the exact tab that
  made a tool call.
- No global, bounded directory of agent tabs exists.
- No mailbox resource exists, and no common dispatch coordinator arbitrates
  user prompts and inter-agent messages.
- Renderer-local unread state is not sufficient for inactive environments or
  another connected client.

## Scope and capability rules

An addressable endpoint is a tab for which the backend can prove all of these:

- the tab is present in the authoritative pane layout;
- it represents a managed agent rather than a plain shell, file, browser, or
  workflow view;
- the backend has a provider-aware way to determine activity and submit a
  prompt without raw, blind PTY injection;
- its agent can receive the Orkestrator MCP tools, or the UI clearly reports
  that replies are manual for that adapter.

The initial delivery adapters should cover:

- every provider hosted by `agent-native` (`claude`, `codex`, `cursor`, `grok`,
  `opencode`, and `pi`);
- `claude-tmux`, using its backend-owned tmux session and existing prompt queue.

Managed CLI terminal modes may join only after their session manager can prove
that the tab is still running the expected agent and can submit through a safe
provider-specific boundary. Do not send messages by writing text into an
arbitrary terminal: it could now contain a shell, an editor, or a confirmation
prompt. Non-addressable tabs remain visible to the user but never appear as
message destinations.

Build, looped-review, and Multi Review tabs are workflow views, not message
endpoints. Their backend-created native job tabs are independently addressable
when present.

## Identity and directory

### Immutable endpoint identity

Add an opaque 128-bit `agentEndpointId` to each addressable `TabInfo`. The
backend, not the renderer, owns its canonical value:

- existing valid IDs are preserved on pane-layout writes;
- a newly observed addressable tab gets a new ID;
- a renderer-supplied replacement ID for an existing tab is ignored or rejected;
- removing and recreating a tab always produces a different endpoint ID, even
  if `tabId` is reused;
- moving a tab between panes retains the endpoint ID;
- changing or resuming a provider session retains the endpoint ID because the
  mailbox belongs to the tab, not one vendor rollout.

This requires a pane-layout schema/version update, parser and merge support,
and migration of existing layouts. Migration should mint IDs while adopting an
authoritative layout, persist once, and tolerate concurrent clients through the
existing compare-and-swap merge.

### Directory projection

Build a directory from authoritative project, environment, pane-layout, and
agent activity snapshots. A directory item contains only:

```typescript
interface AgentMessageEndpoint {
  endpointId: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  tabId: string;
  tabTitle: string;
  tabType: "agent-native" | "claude-tmux";
  provider: AgentPlatform;
  availability: "idle" | "busy" | "offline" | "unavailable";
  receivePolicy: "automatic" | "mailbox-only" | "paused";
}
```

Do not expose worktree paths, transcripts, prompts, terminal output, credentials,
or attachment metadata in the directory. List operations are paginated and can
filter by project, environment, provider, and availability. A send accepts the
opaque endpoint ID, never a mutable title or an ambiguous fuzzy match.

Keep a minimal endpoint tombstone while retained message records refer to it.
That lets history render a stable sender after a tab is closed and prevents a
late reply from being routed to a new tab with the same `tabId`.

## Protocol and storage model

Put the shared wire types, validators, state transitions, and limits in a new
`packages/protocol/src/agent-messaging.ts`. A representative record is:

```typescript
interface AgentMessageRecord {
  version: 1;
  id: string;
  threadId: string;
  replyToMessageId?: string;
  sender: AgentMessageEndpointSnapshot;
  recipient: AgentMessageEndpointSnapshot;
  requestId: string;
  subject?: string;
  body: string;
  createdAt: string;
  state:
    | "queued"
    | "dispatching"
    | "reconciling"
    | "submitted"
    | "acknowledged"
    | "undeliverable";
  stateRevision: number;
  submittedAt?: string;
  acknowledgedAt?: string;
  userSeenAt?: string;
  failure?: AgentMessageFailure;
  dispatch?: AgentMessageDispatchJournal;
}
```

Endpoint snapshots retain the immutable ID and bounded display labels as they
were at send time. They must not retain paths or provider credentials.

The first message uses its own ID as `threadId`. A reply inherits the original
thread and sets `replyToMessageId`. The backend verifies that a reply caller is
one of the thread participants and derives the destination from the parent
record; callers cannot use `reply` to redirect a thread.

### Idempotency

`send_agent_message` and `reply_agent_message` require a caller-generated
`requestId`. Uniqueness is scoped to the asserted sender endpoint. Repeating the
same request ID with identical destination and content returns the original
record. Reusing it with different input is a conflict.

Message creation, reply creation, acknowledgement, and user-seen updates are
serialized in storage. Every mutable call accepts or derives an expected state
revision so two backend tasks cannot both win a state transition.

### Bounds

Start with explicit conservative limits and export them from the protocol:

- body: 32 KiB UTF-8;
- subject: 200 characters and 1 KiB serialized;
- one recipient: at most 100 queued messages and 2 MiB of queued bodies;
- one tool list/read response: at most 50 messages and 512 KiB serialized;
- retained message store: at most 10,000 records and 64 MiB serialized;
- endpoint directory page: at most 100 entries;
- thread reply rate: at most 20 accepted messages per minute;
- one endpoint send rate: at most 60 accepted messages per minute.

These numbers are implementation starting points, not hidden soft limits. A
full mailbox rejects the new send with an actionable error. Pending or
ambiguous authoritative messages are never silently evicted. Only acknowledged,
undeliverable, or user-deleted records are eligible for retention pruning, in
oldest-first order. Put count and byte limits on indexes, idempotency entries,
tombstones, dispatch journals, and decoded request bodies as well as bodies.

Store mailbox content with the same owner-only, atomic sensitive-JSON behavior
as agent handoffs. If one bounded file proves too expensive, partition by
recipient endpoint behind the same `StorageService` contract; do not expose a
filesystem layout to callers. Backups containing deleted messages must be
scrubbed with the same care as handoff backups.

### Resource synchronization

Add `agent-mailbox` to `RESOURCE_KINDS` and the manifest-backed resource set.
Emit only a body-free change after a committed mailbox mutation. The event ID
is the affected endpoint ID and may include its owning project ID for routing.

The authoritative read surface should provide:

- a lightweight global summary of unread and queued counts by endpoint,
  environment, and project;
- a conditional, paginated mailbox snapshot for one endpoint;
- exact lookup by message ID for send status and reply context.

The app-root sync hook loads the summary on boot, reconnect, manifest change,
and periodic reconciliation. A mounted inbox may fetch its page on a targeted
change. Live events are only incremental hints; missing every event must still
converge from these snapshots.

Do not put message bodies, subjects, endpoint titles, or failure details in SSE
frames, metrics, or logs.

## Agent-facing tools and authorization

Extend the existing `AgentToolsServer`, rather than starting another listener.
The environment-scoped credential continues to protect both local and container
connections. Add:

```text
list_agent_tabs
send_agent_message
list_agent_messages
get_agent_message
ack_agent_message
reply_agent_message
get_agent_message_status
```

Suggested behavior:

- `list_agent_tabs` is read-only, paginated, and returns the minimal directory.
- `send_agent_message` requires `requestId`, the caller's `senderTabId`, one
  `recipientEndpointId`, and bounded text.
- `list_agent_messages` defaults to the caller's inbox and supports a stable
  cursor plus state/direction filters.
- `ack_agent_message` is idempotent and succeeds only for the recipient.
- `reply_agent_message` infers the target and thread from the parent message.
- `get_agent_message_status` allows a sender to distinguish queued, submitted,
  acknowledged, and terminal failure without polling whole mailboxes.

Every mailbox operation requires a `callerTabId` (named `senderTabId` for a new
send). The server resolves it against the authoritative directory to an endpoint
inside the credential's environment before applying sender, recipient, or
thread-participant checks. An agent cannot claim a source in another
environment. The caller field is necessary precisely because the shared
environment token does not identify one tab.

The current MCP connection is environment-scoped, so two agents inside one
environment are not cryptographically isolated from one another and could claim
a sibling tab. Document this honestly: an environment is already a shared trust
boundary (workspace, processes, and project-scoped tools). Do not present the
tab attribution as separately verified.

Cross-project messaging intentionally expands the agent tool from a
project-only directory to an app-wide, text-only destination directory. Keep
that expansion narrow:

- it grants no read access to the other project's files, prompts, transcripts,
  tickets, or settings;
- it does not grant a destination agent's credentials or tools;
- it accepts only text and immutable message linkage;
- project/environment deletion immediately revokes the corresponding endpoint;
- environment credential revocation also stops further sends from that source.

If stronger per-tab attribution becomes a requirement, add session-specific
MCP capability tokens only after every provider can install a per-session MCP
connection. Do not implement a security claim that the shared bridge-level
configuration cannot enforce.

The external Control MCP is not the agent-facing path and does not need these
tools for the first release. It may later expose read/administrative operations
through its separate user-controlled credential.

## Delivery lifecycle

### Phase-one pull delivery

The first executable slice is a durable mailbox. An agent reads messages with
`list_agent_messages`, acknowledges them, and replies explicitly. Tool
instructions should tell agents to check their mailbox at the start of work,
before reporting idle when coordinating with another tab, and after a long
operation. This slice proves identity, storage, cross-project authorization,
and UI rehydration without introducing prompt scheduling risk.

Pull delivery alone is not the finished product because an idle agent will not
spontaneously call a tool.

### Automatic delivery

Add a backend-owned `AgentMessagingService` that feeds recipient messages into
the same per-logical-session dispatch coordinator as normal user prompts. It
must not maintain an independent drainer that can race the prompt queue.

The coordinator applies these rules:

1. Commit the mailbox record before enqueueing any delivery work.
2. Reconcile a committed message missing its queue pointer at boot or after a
   partial write. A pointer whose message no longer exists is removed.
3. Preserve existing user-prompt order. An inter-agent burst must neither jump
   ahead of already queued user work nor starve later user work; cap queued
   messages and schedule at most one bounded agent-message batch between user
   dispatches when both classes are waiting.
4. Never inject into a running turn. A busy recipient stays queued until the
   native activity snapshot or tmux session reports a safe boundary.
5. A detached native session may be attached best-effort outside the
   at-most-once window. The authoritative prompt dispatch still performs the
   same attach if needed.
6. A stopped environment keeps the message queued. Environment start/recovery,
   agent turn completion, prompt-queue changes, and a bounded background sweep
   all wake the coordinator.
7. Submission uses a deterministic request ID derived from the message or batch
   ID. Existing provider dispatch journals remain authoritative.
8. Only an explicit provider rejection known to precede execution is eligible
   for automatic retry. Timeout, disconnect, malformed response, or an
   unreadable journal is ambiguous and must park for reconciliation.
9. Never report `submitted` until the provider's own dispatch path gives an
   explicit positive result. Never report `acknowledged` merely because a turn
   finished.
10. Tab close marks queued records undeliverable. It does not reroute them to a
    replacement tab. A submitted/ambiguous record retains its journal for
    reconciliation.

The existing `PromptQueueDrainer` and native dispatch service already encode
much of the necessary claim/submitting/submitted boundary. Extend their queue
item metadata with an origin such as:

```typescript
type PromptOrigin =
  | { kind: "user" }
  | { kind: "agent-message"; messageIds: string[]; batchId: string };
```

The messaging service observes the same dispatch result and advances the
mailbox records. A crash between the queue and mailbox writes is repaired from
the origin pointer and message dispatch journal. Recovery must be idempotent in
both directions.

### Prompt carrier

Render one or more messages into a versioned provider-neutral carrier. The
visible instruction should identify the source project/environment/tab, include
message and thread IDs, and say:

- this is collaborator input, not a user authorization or approval;
- normal sandbox, network, approval, and project rules still apply;
- reply through `reply_agent_message` when a response should reach the sender;
- acknowledge explicitly if no reply is needed.

Message text is JSON data, not executable carrier structure. Escape markup and
Unicode separators as the handoff carrier does, parse only validated versions,
and rebuild any display text from validated fields. A body containing carrier
tags must not escape its frame or hide adjacent provider messages.

Automatic delivery may batch consecutive messages for one recipient up to 10
messages or 64 KiB serialized, whichever comes first. It preserves per-recipient
creation order and carries every message ID so acknowledgement can be exact.

Do not automatically turn the recipient's ordinary assistant response into a
reply. Explicit reply tools avoid leaking an entire response, make the intended
recipient clear, and place a natural brake on agent feedback loops.

## UI plan

Create an app-level `agentMessagingStore` hydrated from backend summaries and
mailbox pages. Mount synchronization once near the existing resource sync, not
inside an individual tab.

### Discovery and sending

Add a “Message another agent” action to agent tab chrome or Agent Info. The
picker groups exact destinations by project and environment, shows provider,
tab title, availability, and automatic-delivery state, and excludes the current
endpoint. Search is local over the bounded directory page or backend-paginated
for larger installations.

Manual user-authored messages are useful for testing and recovery, but must use
the same backend command and idempotency contract as agent-authored messages.
The UI never writes mailbox state directly.

### Inbox and transcript presentation

Add an inbox/sent panel for each addressable tab. Message rows show:

- source/destination breadcrumb;
- subject and bounded preview;
- queued, submitted, acknowledged, or undeliverable state;
- thread/reply relationship;
- explicit “seen by you” and “acknowledged by agent” distinctions;
- retry/discard controls only when the backend state makes that action safe.

Provider transcripts should render a parsed automatic-delivery carrier as a
compact “Message from agent tab” card rather than raw JSON. This is display
normalization only; the durable mailbox remains authoritative.

Tab badges show unseen incoming count. Environment and project badges aggregate
those counts from the global summary. Do not overload `hasUnreadWork`: clearing
message UI receipts must not clear unrelated completed-work notifications, and
opening an environment must not mark every contained message as seen.

Marking user-seen is an explicit backend mutation fenced by the mailbox state
revision. The renderer may update optimistically but must accept the
authoritative result when another client or a newer message wins the race.

### Controls

Each endpoint has a backend-owned receive policy:

- `automatic` — queue and wake through normal dispatch when safe;
- `mailbox-only` — accept messages but require a tool/UI read;
- `paused` — reject new sends with a clear reason while retaining history.

Automatic wake is not a safe default for a cross-project feature that can run
an agent able to modify a workspace. Default new endpoints to `mailbox-only`;
the user may opt an endpoint or a global default into `automatic`. Pausing or
switching policy is durable and visible in discovery. A global emergency pause
can stop all new cross-tab sends without deleting accepted messages.

## Failure and lifecycle behavior

| Situation | Required result |
| --- | --- |
| Recipient is busy | Keep queued; deliver at the next safe boundary. |
| Recipient environment is stopped | Keep queued and show offline; retry after authoritative environment recovery. |
| Recipient tab is inactive/unmounted | No effect on delivery; backend continues and UI later rehydrates. |
| Backend restarts before dispatch | Rebuild pending work from mailbox and queue snapshots. |
| Backend restarts during submission | Reconcile the deterministic request ID; never blind-retry an ambiguous turn. |
| Gateway/SSE cursor expires | Manifest reconciliation refetches mailbox summary and affected pages. |
| Recipient tab closes | Mark queued messages undeliverable; never retarget a reused `tabId`. |
| Sender tab closes | Existing recipient records retain a tombstone; new replies fail clearly rather than targeting another tab. |
| Environment is deleted | Purge bodies involving that environment, scrub backups, and leave only content-free counterpart tombstones where needed for status. |
| Project is deleted | Apply the same purge to all owned environments/endpoints. |
| Mailbox is full | Reject the new send; do not discard accepted messages. |
| Recipient provider lacks safe dispatch | Expose mailbox-only capability or omit it as a destination; never raw-write a PTY. |
| Approval times out or disconnects | Existing provider behavior denies; a message never grants approval. |

Environment deletion should call one storage/service method that disables
endpoints, settles pending deliveries, removes message bodies and queue pointers,
and scrubs retained sensitive backups before the environment record disappears.
Tab teardown should perform the endpoint transition before reaping its provider
session. Both operations must be safe to retry after a partial shutdown.

## Security and privacy invariants

1. An accepted message is untrusted collaborator text, never user authority.
2. Receiving a message cannot approve a tool, broaden sandbox/network access,
   change project scope, or bypass the destination provider's normal controls.
3. Agent-tools credentials remain bearer secrets, are never persisted in the
   mailbox, and are revoked with their environment.
4. Source attribution is verified to the credential's environment but not to
   one tab within that shared trust boundary.
5. Cross-project discovery exposes only the minimal endpoint directory.
6. Phase one accepts text only. No file attachments, absolute paths, transcript
   transfer, tool-output blobs, or implicit workspace reads.
7. Bodies and subjects are sensitive data: never log, meter, trace, or emit
   them in resource events. Metrics may contain only aggregate counts, byte
   buckets, latency, and terminal state.
8. Every request, response, carrier, queue, journal, retained record, tombstone,
   backup, and in-memory index has explicit count and byte bounds.
9. Rate limiting is enforced at the backend credential/endpoint boundary, not
   only in the UI or tool description.
10. Automatic agent replies are never inferred from provider output. A reply
    requires an explicit tool call and idempotency key.
11. A message cannot address its own endpoint, and reply/thread validation
    prevents a caller from manufacturing a third-party relay.
12. Logs use state and aggregate identifiers only. If a diagnostic needs a
    message correlation value, use a short one-way digest rather than content or
    a user-facing title.

## Implementation map

### Shared protocol

- Add `packages/protocol/src/agent-messaging.ts` with endpoint/message schemas,
  validators, transition helpers, cursor rules, carrier version, and bounds.
- Add `agentEndpointId` and receive policy to the canonical pane-layout/tab
  schema and merge rules.
- Add `agent-mailbox` to `packages/protocol/src/resource-events.ts` and its
  manifest set.

### Backend storage and commands

- Add a focused `storage-agent-messaging.ts` mixin/module rather than growing an
  unrelated storage file.
- Extend `StorageService` with endpoint directory, mailbox page/status,
  idempotent send/reply, acknowledgement, user-seen, receive-policy, pruning,
  and lifecycle purge operations.
- Add `commands-registry-agent-messaging.ts` and register it from
  `createCommandRegistry()`.
- Add conditional snapshot support for mailbox summaries/pages.
- Canonicalize endpoint IDs while saving/migrating pane layouts.

### Backend service and dispatch

- Add `agent-messaging-service.ts`, owned and started from backend `index.ts`.
- Give it storage, activity snapshots, the native agent service, tmux session
  manager, and the existing prompt dispatch coordinator through narrow
  interfaces in `commands-context.ts`/dependencies.
- Extend prompt queue items and `PromptQueueDrainer` with a validated origin and
  completion callback; keep one claim/submission fence per logical session.
- Trigger reconciliation on boot, endpoint/activity changes, turn completion,
  environment recovery, and a bounded safety sweep.
- Integrate endpoint disable/purge with tab teardown and project/environment
  deletion.

### Agent tools

- Extend `apps/backend/src/core/agent-tools.ts` with the messaging tools and
  schemas above.
- Preserve the existing environment/project ticket scope while adding only the
  minimal app-wide endpoint/message authority.
- Update the MCP server instructions so an agent knows how to discover, send,
  acknowledge, and explicitly reply.
- Update bridge and tmux health/fingerprint tests only if the connection schema
  changes; do not put endpoint identity into a process-wide token and pretend it
  is per-tab.

### Renderer

- Add backend client wrappers and runtime validation for directory, mailbox,
  status, policy, and receipt commands.
- Add `agentMessagingStore` and one app-root resource-sync hook.
- Add inbox/sent UI, destination picker, unread badges, policy controls, and
  safe error/recovery actions.
- Parse and render the versioned inter-agent carrier in the shared native
  message normalization layer and the Claude tmux transcript adapter.
- Ensure pane-layout persistence/restore/merge retains backend-owned endpoint
  IDs without stale renderer copies replacing them.

## Phased delivery

### Phase 0 — protocol and adapter inventory

- Freeze endpoint, message, state, cursor, carrier, and error schemas.
- Inventory every current agent tab path and record whether it has authoritative
  activity, safe prompt submission, prompt idempotency, and MCP availability.
- Add a capability table/test that prevents a new agent tab type from silently
  appearing as messageable without an adapter decision.

Exit: shared types and an explicit support matrix exist; no UI guesses support
from a provider string.

### Phase 1 — endpoint identity and directory

- Migrate pane layouts to immutable backend-canonical endpoint IDs.
- Implement the minimal paginated directory and endpoint tombstones.
- Prove concurrent pane-layout clients cannot replace or duplicate identity.

Exit: every supported existing tab has one stable endpoint across pane moves,
reloads, provider-session changes, and backend restart.

### Phase 2 — durable mailbox

- Implement bounded storage, idempotent send/reply, ack, user-seen, status,
  pruning, deletion, summaries, resource events, and manifest reconciliation.
- Add backend command/client wrappers and storage/protocol tests.

Exit: two UI/API callers in different projects can exchange and rehydrate a
message with no provider dispatch involved.

### Phase 3 — agent MCP pull workflow

- Add discovery, send, read, ack, reply, and status tools.
- Enforce environment source scope, global destination rules, bounds, quotas,
  rate limits, and deletion revocation.
- Add agent instructions and end-to-end local/container MCP tests.

Exit: agents in two different projects can exchange an acknowledged reply by
calling tools, including across a backend restart.

### Phase 4 — automatic native delivery

- Integrate agent-message origins with the single prompt dispatch coordinator.
- Add safe batching, offline/busy handling, attach, exactly-once request IDs,
  ambiguous recovery, and explicit recipient reply instructions.
- Start with one native adapter behind the capability table, then enable the
  remaining native platforms only after the same contract tests pass.

Exit: an inactive native recipient is woken exactly once when safe, and all six
native platforms pass the same lifecycle suite.

### Phase 5 — Claude tmux and UI completion

- Add the tmux adapter without blind PTY writes.
- Ship inbox/sent views, global destination picker, status, badges, policy,
  pause, retry/discard, and carrier cards.
- Exercise desktop, browser gateway, multiple connected clients, narrow layout,
  keyboard, and accessibility paths.

Exit: the product contract at the top of this document is met for every listed
initial adapter.

### Phase 6 — hardening and optional adapters

- Stress quotas, batching, rate limiting, store corruption, backup scrubbing,
  restart reconciliation, and gateway replay expiry.
- Add managed CLI terminal adapters only where safe agent-state detection and
  provider-aware submission are available.
- Consider per-session MCP credentials only as a separately reviewed security
  improvement with support across every enabled provider.

## Verification matrix

### Protocol and storage

- Accept every valid state transition and reject regressions or malformed
  records.
- Prove UTF-8 byte limits, response pagination, store limits, and rate limits at
  exact boundaries.
- Race duplicate request IDs from two callers; one record must result.
- Reuse a request ID with changed content; it must conflict.
- Race ack, reply, user-seen, tab close, and retention pruning under revisions.
- Corrupt primary and backup records; unrelated valid mailboxes remain usable,
  and deletion never restores sensitive content from a backup.

### Identity and authorization

- Rename projects/environments/tabs after discovery; endpoint IDs still route
  correctly while snapshots retain send-time labels.
- Close and recreate a stable `tabId`; a late message/reply never reaches the
  new endpoint.
- Reject a sender tab outside the MCP credential's environment.
- Allow a valid cross-project destination without exposing its project data.
- Revoke the source environment and prove its old credential cannot send.
- Delete a recipient environment/project and prove bodies, queue pointers, and
  backups are removed.

### Dispatch reliability

- Send while recipient is idle, busy, detached, stopped, starting, cancelling,
  recovering, and missing.
- Switch to another environment before send/delivery completes; return and
  rehydrate exact status and transcript card.
- Restart before queue insertion, after queue insertion, before provider call,
  during ambiguous submission, after explicit submission, and before mailbox
  acknowledgement.
- Confirm an ambiguous request parks and reconciles; it is never auto-retried.
- Confirm user prompts and messages share one session fence and obey fairness.
- Confirm batching preserves order and acknowledges individual message IDs.
- Confirm approvals, disconnects, and malformed answers still fail closed.

### Events and clients

- Miss resource events while the tab/environment tree is unmounted; manifest
  reconciliation restores counts and pages.
- Expire the gateway replay cursor and rotate the backend generation.
- Run two clients: send/read/mark-seen in one and converge the other without a
  write loop.
- Backpressure the event client; message bodies never enter the replay ring and
  authoritative mailbox changes are not silently dropped.

### UI and carrier safety

- Verify empty, loading, partial page, success, full mailbox, paused, offline,
  ambiguous, failed, and deleted-endpoint states.
- Verify tab/environment/project badges and separate user-seen versus agent-ack
  receipts.
- Put carrier tags, malformed JSON, huge Unicode, ANSI/control characters, and
  prompt-like instructions in a body; the parser must preserve them as data.
- Ensure the renderer hides the raw carrier only when validation succeeds.
- Test keyboard navigation, focus return, screen-reader labels, and normal/narrow
  layouts.

### Real-stack acceptance scenario

1. Create two projects and one environment in each.
2. Open different supported agent providers in each environment.
3. From agent A, discover B and send a request with a fixed idempotency key.
4. Switch to a third environment so neither tab is mounted.
5. Let B receive the request, acknowledge it, and explicitly reply.
6. Restart the backend during a second exchange at a controlled dispatch
   boundary.
7. Return to A and B; verify one copy of each message, exact states, thread
   linkage, unread badges, transcript cards, and no raw carrier.
8. Reload another client and verify the same state from authoritative snapshots.
9. Close B, recreate a tab with the same visible title, and verify a late send to
   B's old endpoint becomes undeliverable rather than reaching the replacement.

## Completion criteria

The work is complete only when:

- accepted sends are durable and idempotent across projects and restarts;
- source and destination are immutable endpoint identities rather than titles or
  reusable tab IDs;
- every initial adapter uses authoritative activity and a safe provider-aware
  dispatch path;
- normal user prompts and agent messages cannot race one another;
- ambiguous submission is detectable, parked, and reconciled without duplicate
  execution;
- inactive environments and missed events rehydrate from mailbox snapshots;
- user-seen, provider-submitted, and agent-acknowledged are distinct states;
- deletion, quotas, backups, logs, metrics, and events satisfy the security and
  byte/count bounds above;
- the full protocol/storage/service/UI test matrix and the real-stack scenario
  pass for local and container environments.
