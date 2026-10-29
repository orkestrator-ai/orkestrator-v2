# Agent messaging

Status: Living — inventory of the durable mailbox, idle injection, and
provider capability flags. Keep aligned with
`packages/protocol/src/agent-mail.ts`.

Agents in Orkestrator can send bounded Markdown to each other through a
backend-owned store. The store is shared. What differs by provider is whether
a tab can **pull** mail with tools, **send** as itself, and be **injected**
into — woken with a new turn that carries the message. Those three flags are
the product gate. Everything else (directory, inbox UI, retention, trust,
idempotency) is the same for every addressable mailbox.

This document describes the complete feature set first, then how each
provider reaches it. The comparison matrix at the end is the gap list.

Related: [`control-mcp.md`](./control-mcp.md) for the operator/coordinator
MCP surface, [`coordinator.md`](./coordinator.md) for delegation, and
[`agent-engines.md`](./agent-engines.md) for per-engine process wiring.

## What “complete” means

A fully featured participant can do all of the following. Native Claude,
Codex, OpenCode, Pi, Cursor, and Grok all can. Terminal cursor/grok/pi
tabs are still not addressable; OpenCode still uses an environment-scoped
MCP token.

| Capability | Meaning |
| --- | --- |
| Durable mailbox | A synced inbox keyed by environment + tab, with an incarnation that changes when the tab is replaced |
| Directory | Discover other addressable tabs (`list_mailboxes`) |
| Send | Place bounded Markdown in one inbox (`send_message`), idempotent on `requestId` |
| Reply | Answer a tab or coordinator sender; destination is derived (`reply_message`) |
| Pull | List metadata, read one body, without acknowledging (`check_inbox`, `read_message`) |
| Agent ack | Mark handled, separately from the human seen receipt (`ack_message`) |
| Sent status | Read placement and both receipt states for mail this tab sent (`get_message_status`) |
| Idle inject | When policy allows, the store drains pending mail into a new user turn as a tagged carrier |
| Presence gate | Inject only when the recipient is idle (or an unprompted “cold” native tab) |
| User inbox | Messages panel (conversations, compose), per-tab banner, mute and inject-policy overrides |
| Routed wake | Coordinator ↔ the workers it created, and peer ↔ peer while **Wake peers** is on, wake the recipient even when the default inject policy is off (see [Routes](#routes)) |

A carrier the recipient cannot acknowledge is not a usable delivery channel:
it never becomes retention-eligible and eventually wedges the mailbox
backlog. That is why **pull, send, and inject flip together**. There is no
supported “inject-only” or “send-only” native provider.

## Shared store

The store lives in backend application data (`storage-agent-mail.ts`). It is
not a provider transcript and not chat history. Closing a tab tombstones its
mailbox; the messages remain until retention prunes them.

**Address.** `agentMailboxId(environmentId, tabId)` is an opaque
`environmentId\0tabId` string. Coordinators use a runtime environment id
`coordinator:<coordinatorId>:<conversationId>` and the conversation’s
`tabId`.

**Kinds.** Only some pane-layout tabs become mailboxes:

| Tab type | Kind | Typical agent |
| --- | --- | --- |
| `agent-native` | `native` | Locked platform on the tab |
| `claude-tmux` | `tmux` | Claude |
| `claude`, `codex`, `opencode` | `terminal` | Same as tab type |
| `cursor`, `grok`, `pi` terminal, `plain`, `browser`, workflow tabs | none | Not addressable |

Review and workflow tabs (`claude-build`, `multi-review`)
are never mailboxes.

**Actors.** Every message records who sent it:

| `from.kind` | Who | Typical path |
| --- | --- | --- |
| `tab` | An agent mailbox | Agent Tools MCP |
| `coordinator` | A project coordinator conversation | Control MCP with a coordinator credential |
| `user` | The human in the Orkestrator UI | `send_agent_mail` |
| `system` | A backend workflow | Completion notices with a stable outbox id |
| `external` | A Control MCP operator credential, or `orkestrator mail send` | `send_external_agent_mail` (public action `mail.send`) — inbox only |

**Trust.** Derived at send time from sender and recipient project/environment:

`user` · `same-environment` · `same-project` · `cross-project` · `external`

Cross-project and external mail is stored and never auto-injected. The
carrier text tells the model the payload is untrusted.

**Placements.**

| Placement | Meaning |
| --- | --- |
| `stored` | Durable; recipient must pull, or a later promotion/retry may schedule inject. Turning a mailbox's delivery on (off → idle, or unmuting inbound) promotes its unhandled stored mail |
| `pending-inject` | Waiting for the drain; busy, queue, draft and parked-dispatch holds retain a reason and retry backoff |
| `injected` | Carrier was accepted as a prompt |
| `inject-held` | Held by an open worker delegation or hop budget, or claimed with reason `submitting` while dispatch is in flight |
| `inject_failed` | Only after automatic recovery gave up: an ambiguous dispatch the journal never settled, or a tmux dispatch with no journal. UI can retry |
| `undeliverable` | Recipient gone or superseded |
| `bounced` | Policy refusal (muted inbound, messaging disabled, …) |
| `expired` | Past retention |

**Receipts are two bits.** `userSeenAt` is the human opening the inbox.
`ackedAt` is the agent calling `ack_message` (or `reply_message`, which acks
the parent). Retention and backlog eligibility care about the agent ack.
The UI counts them separately (`userUnseenCount` vs `agentUnackedCount`).

**Limits** (`packages/protocol/src/agent-mail.ts`):

- Body 32 KiB UTF-8, subject 200 characters, `requestId` 256
- 200 messages per mailbox, 2 000 mailboxes, 2 000 pending injects
- Store 32 MiB, measured as the stored (compact) JSON of the envelope and its rows
- Thread hop limit 8 for unrouted mail; routed mail uses the budgets below
  (default 16 per budget, 40 per pair per hour)
- Default retention 14 days (1–365)
- Inject batch: 10 messages or 128 KiB of rendered carriers per wake
- Agent Tools rate limits: read 30/min and 2 000/day; send 20/min and 200/day, per `(environment, tab, kind)`

There are no attachments, no multicast, and no search-over-bodies API. One
`requestId` per sender scope is idempotent; retrying the same id with a
different body is `idempotency-conflict`.

A tab cannot send to its own mailbox (`policy-denied`). Subagents and
background tasks inside a tab share that tab's credential and address, so
"mail to the parent" would only come back to the sender, and it would wait
for the whole tab to go idle.

## How a message moves

```text
sender  --send-->  store (placement + trust)
                      |
                      +-- user / agent pull  -->  read, ack, reply
                      |
                      +-- shouldScheduleInject?
                             no  --> stored | inject-held | bounced
                             yes --> pending-inject
                                        |
                                        v
                                   ~2s drain
                                        |
                          presence idle / unknown (native cold tab)
                                        |
                                   begin claim + batch siblings
                                        |
                          native dispatchMailInject  |  tmux submit
                                        |
                              accepted --> injected
                              held     --> pending-inject (reason + backoff)
                              failed   --> inject_failed
```

### Routes

Every same-project message from a tab, a coordinator, or a workflow is given a
**route** at send time (`classifyAgentMailRoute` in
`packages/protocol/src/agent-mail.ts`), stored on the message as `route`:

| Route | Between | Wakes the recipient? |
| --- | --- | --- |
| `coordinator` | The main coordinator and a worker it (or a former main) launched; a coordinator and a tab no coordinator created; main ↔ side agent; workflow (`system`) notices; [node mail](#node-mail) | Yes |
| `peer` | Two tabs, neither in an environment a coordinator created (including sibling tabs in one environment) | Yes, while **Wake peers** is on (off by default) |
| `isolated` | A tab in a coordinator-created environment and anyone other than its own coordinator: sibling workers, a worker and a peer, a worker and another conversation | Only if the recipient's policy is `idle` and inject depth is 0, like unrouted mail |

User, external and cross-project mail has no route.

A mailbox's `coordinatorOrigin` is the mail address of the main coordinator
whose coordinator launched its environment, derived on every mailbox sync from
the coordinator's launch associations (those carrying a base commit), so a
delegation that merely messages or prompts an existing environment never
makes it a worker. Workers belong to the main whichever conversation launched
them; while no main is open the origin is the coordinator's bare runtime id, so
the worker stays attached rather than becoming a peer.

**Addresses.** `"coordinator"` resolves to the sender's project's main
coordinator, starting one if it was closed (see
[`coordinator.md`](coordinator.md#one-main-coordinator-and-side-agents)). The
address of a closed conversation is redirected there as a new message (no
reply threading into a conversation that no longer exists). `toTabId` may be
omitted for a coordinator address, and for an environment: it resolves to the
tab a coordinator is waiting on, the environment's only agent tab, or its
`startup-agent`, and otherwise fails listing the tab ids. Idempotency keys on
the address the sender wrote, so a retry still matches after a redirect.

**Side agents** send only to their main coordinator and receive only from it
(and the user); anything else is `policy-denied`.

### Node mail

Mail between a command node's coordinator and an agent on a node it
controls ([command-nodes.md](command-nodes.md#coordinators)) crosses the node
link: the command node delivers coordinator mail with `deliver_node_mail`,
and collects an agent's mail to `"coordinator"` (or a reply on such a
thread) from that node's outbox. On a leaf, `"coordinator"` is the
coordinator that last contacted the sending environment, local or remote,
and a reply always goes back to its sender; see
[command-nodes.md](command-nodes.md#updates-from-leaves). The `send_message`
result names the destination in `coordinator` (`this machine` or
`command node <name>`). Each side stores it with a `node` sender
(`NodeMailActor`): the node, the remote party's role (`coordinator` or
`agent`) and its address on its own node, and the recipient's own project for
the same repository. The node link authenticates it, so it is
`same-project`, takes the `coordinator` route and wakes the recipient; it is
budgeted as one remote sender (`nodeMailSenderKey`), and a new request
starts a pair budget as a local delegation does. A leaf agent's report to a
coordinator waiting on it is held for that remote delegation like a local
worker's, and released when the delegation settles.

A waking route ignores the default inject policy and inject depth. Only an
explicit per-tab **Off**, a mute, or the pair hop budget stops it; per-tab
`idle` and `inherit` both count as on. Mail sent before routes existed keeps
the coordinator-exchange rule it was scheduled under.

### Scheduling

`shouldScheduleInject` (`storage-agent-mail.ts`) is true only when all of
these hold:

1. Global messaging is enabled (and not relevantly paused for the schedule
   itself — pause still accepts mail).
2. Recipient inject policy is `idle`, **or** the message's route wakes.
3. Inbound is not muted.
4. Trust is not `cross-project` or `external`.
5. Inject depth is 0, unless the route wakes.
6. For unrouted mail, thread depth is below 8. For a waking route, the pair
   is inside its budget and its hourly limit (see [Budgets](#budgets)).
7. Recipient `canInject`.
8. The sender is not a worker still held by an open delegation to this
   coordinator conversation.

### Budgets

Routed mail is bounded two ways, both per pair of mailboxes and both
settings under **Settings → Messaging**:

- **Unattended budget** (`autonomousWakeBudget`, default 16). Each routed
  message's depth is one more than the latest routed message between the
  pair, either direction, whatever its subject. At the budget the message is
  `inject-held` with `loop-budget-exhausted`. A new budget starts when:
  - a coordinator sends its worker a message (a new request, so the message
    is depth 0);
  - anyone prompts either tab through `dispatch_native_agent_prompt`,
    `dispatch_native_agent_intent` or `enqueue_prompt_queue_message` — a
    person in the renderer or CLI, or a coordinator's `send_prompt_to_tab`.
    The tab's `budgetResetSequence` moves past every earlier routed message.
    Mail already held stays held;
  - the user presses **Resume**, which releases every budget-held message in
    that tab's inbox at once and resets the tab.
- **Hourly limit** (`hourlyWakeLimit`, default 40). Counts routed messages the
  pair scheduled in the last hour. Over it, mail is `inject-held` with
  `hourly-limit` and the drain releases it, oldest first, as the window moves
  (checked every 30 s). Resume releases it early.

When a worker's mail to its coordinator is held by either, the coordinator
gets one workflow notice per budget (or per hour), so it can read the held
mail and decide. Peers get no notice; the sender's `send_message` result and
the recipient's banner show the hold.

A coordinator's status notices (see [`coordinator.md`](coordinator.md#status-wakes))
have no sending mailbox, so each carries `statusBudgetKey`
(`agentMailStatusBudgetKey`): a stand-in sender per resource. That makes a
Multi Review, a build pipeline or a delegated tab and its coordinator a routed
pair like any worker, and both budgets above hold its notices. The other
workflow notices (a delegation's finished notice, held-mail and terminal
notices) stay outside the budgets. A status notice is also placed with a
10-second coalescing hold (`coalesceMs`): it joins a hold already open for the
same mailbox, so notices that land together are delivered as one batch.

Mail that is only stored records why in `placementReason`: `inject-policy-off`,
`isolated-route`, `reply-to-injected-turn`, `recipient-cannot-inject`,
`untrusted-sender`, or `hop-limit`. `get_message_status` returns it to the
sender.

**Releasing one message.** Retry, Resume and **Deliver now** call
`retry_agent_mail_inject`, which stamps `userReleasedAt`. The drain delivers a
released message once even when the mailbox policy is off, so the banner no
longer rewrites the tab's policy to deliver a single message.

**Deliver now into a running turn.** Deliver now passes `now: true`, which
also marks the message's pending entry `steerRequested`. If the recipient's
presence is `working`, `waiting` or `draft`, the next drain pass claims the
batch as usual. Instead of waiting for the turn to end, it offers the batch to
the running turn through `steerMailInject`, the same persisted steer path as a
typed `/steer`. The carrier is capped at 60 KB because a steer carries at most
64 KB.

Each attempt gets a fresh UUID: the Claude bridge uses the id as the message
uuid and remembers every id it has been offered. The id is stamped on the
claim (`steerRequestId`), so a restart asks the steer journal about it. The
outcomes:

- **Applied:** the message is `injected`.
- **The turn has already ended:** the message goes out the ordinary way in the
  same pass.
- **No answer:** the message waits as `verifying`, and `reconcileMailSteer`
  confirms it against the session's delivered history, its parked steer, and
  then the provider's steer journal. A steer id that none of these knows is
  `unknown`, never treated as unsent, so it eventually fails closed like any
  other ambiguous dispatch.
- **Refused:** the agent can't steer (`steer-unsupported`; tmux agents always
  get this), or the turn or session refused the steer (`steer-refused`). The
  message goes back to waiting for the turn to end, and the banner says why.

There is one steer attempt per press, and any settlement clears the flag. The
command waits for the drain before it answers, so the banner reports the
result as soon as the attempt finishes. A message delivered by a steer
records `injectedVia: "steer"`.

A coordinator asks for the same thing with `deliverNow: true` on
`send_message`: `sendAgentMail({ steer: true })` sets `steerRequested` on the
new pending entry, for coordinator senders only and only when the message is
placed `pending-inject`. After the command's single delivery pass, an unused
steer request is cleared even if eligibility, paused messaging, or environment
readiness prevented an attempt. The result carries the settled message fields;
a completed request-ID replay reports its persisted success without redelivery.
See
[`coordinator.md`](coordinator.md#course-corrections-with-delivernow).

**Logs.** The backend logs one `[agent-mail] placed` line per send, one
`[agent-mail] waiting` line each time the drain's reason for passing over a
pending message changes, and one `[agent-mail] dispatched` line per batch.
They carry ids, route, placement and reason, never subjects or bodies.

A worker that chats while the coordinator is waiting has its mail stored
and released once when the delegation completes. That is intentional: one
delegation is one wake, not a chat room.

The drain (`agent-mail-service.ts`) batches every other eligible pending
message for the same mailbox into one prompt, in send order, so three
worker replies do not become three coordinator turns. Over-budget siblings
are put back (`held` / `batch-full`) for the next pass.

**Carrier.** `renderAgentMailCarrier` wraps JSON in
`<orkestrator-peer-message>`. The body is JSON-escaped so a hostile payload
cannot close the tag. The wrapper states trust, tells the model to use
`reply_message` / `ack_message`, and says paths refer to the sender’s
filesystem.

The JSON payload is also the transcript's structured marker. Besides `from`,
`subject` and `body` it carries `kind` (`message`, `coordinator`, `user`,
`external` or `notice`), which `agentMailKind` derives from the authenticated
sender and trust, so a tab cannot make its mail look like a workflow notice. A
workflow notice (`from.kind === "system"`) may also carry `notice`: the
resource it reports on (`agent-tab`, `multi-review`, `build-pipeline`, with
ids and a label), a lower-case `state` (`completed`, `failed`, `waiting`,
`ready`…) and a `tone` (`success`, `failure`, `attention`, `info`). The store
persists it on the message (`AgentMailMessage.notice`, only for system senders,
checked by `normalizeAgentMailNotice`), so `read_messages` and `get_message`
return it too.

**Presence.** Native inject uses `mailInjectPresence` (queue, compose draft,
pending dispatch, environment readiness, then turn activity). Drain admits
`idle` and `unknown` (never-prompted tab). The dispatch fence rechecks the
same turn view under the session lock, with a fresh post-dispatch
observation. A turn that ended while its subagents or background tasks
still run reads as idle there (`readyForInput`): the Claude bridge writes the
carrier into that same CLI rather than resuming a second one (see
`bridges/claude-bridge/AGENTS.md`, “One CLI per session”). Tmux requires
observed idle and will not restart a stopped session. Terminal-kind
mailboxes are never drained.

Interrupted native injects are reconciled on backend start against the
session’s dispatch journal (`reconcileMailInject`).

**Automatic retry.** Nobody has to press Retry for mail to arrive:

- A dispatch refused before the agent saw it (checkout lease, bridge start
  failure, rebuild fence) goes back to `pending-inject` with reason `retrying`
  and a hard `retryAt` — 10 s, 30 s, 1 min, 2 min, 5 min, 10 min, then every
  15 min for as long as the message is retained. Busy backoff resets on an
  activity edge; `retryAt` does not.
- A native dispatch whose outcome is unknown goes to `pending-inject` with
  reason `verifying`. Before anything is resent the drain asks the session's
  dispatch journal under the request id it was sent with: delivered settles as
  `injected`, provably not delivered is retried, still unknown is asked again
  on the same schedule. After 8 inconclusive answers it fails closed as
  `inject_failed` (`ambiguous`), so mail is never sent twice.
- A tmux dispatch has no journal and still fails closed at once.

A manual Retry skips the remaining wait but keeps a pending journal check. A refusal the bridge
proves was not processed (409, 503, unreachable) is held and retried, and
its dispatch-journal row is released before reporting a busy hold. If cleanup
fails, the mail stays pending with a parked reason and the durable session
retains proof of refusal. Presence reconciliation retries that cleanup before
the next drain; ambiguous rows are never cleared through this path.

## Three MCP surfaces

The tool *names* overlap. The credentials do not.

A fourth, narrower surface is the attempt-scoped workflow-result server: one
backend-owned turn's result tools, plus `report_finding` for a live Multi
Review reviewer. It carries no mail or ticket tools; see "Workflow results
through tool calls" in [agent-engines.md](agent-engines.md).

### Agent Tools MCP — tab identity

`apps/backend/src/core/agent-tools.ts` + `agent-tools-messaging.ts`.

This is the server interactive agents use. A credential is scoped to one
tab or to one environment. Environment credentials resolve a mailbox only
when exactly one live pull-capable tab exists, or the caller passes
`tabId` / `fromTabId` to claim one.

Tools (always the same set; enforcement is at call time):

| Tool | Role |
| --- | --- |
| `list_mailboxes` | Directory, with `self` marked |
| `send_message` | Send as this tab |
| `check_inbox` | Metadata page, default unread |
| `read_message` | One body, no ack |
| `ack_message` | Agent receipt |
| `reply_message` | Derived destination; acks the parent |
| `get_message_status` | Placement and receipts for mail this tab sent |
| `create_schedule`, `list_schedules`, `cancel_schedule` | Mail (or a reminder to this tab) sent later by the backend, as this tab; see [scheduled-jobs.md](scheduled-jobs.md) |

If the resolved mailbox has `canPull: false`, every tool returns
`capability-denied`. Connecting the HTTP MCP server is not the same as
having a working mailbox.

### Control MCP — operator

`apps/backend/src/core/control-mcp-server.ts`, documented in
[`control-mcp.md`](./control-mcp.md).

An operator credential with the `mail` capability can `list_mailboxes` and
`send_message` (the public actions `mail.mailboxes` and `mail.send`, which the
CLI reaches as `orkestrator mail mailboxes/send`). Those sends are always
`external` and **never injected**. The human reads them in the global inbox.

### Control MCP — coordinator credential

The same HTTP endpoint, a different bearer token, bound to one project,
workspace, conversation, and mailbox incarnation.

Coordinator mail tools: `list_mailboxes`, `send_message`, `read_messages`,
`get_message`, `get_message_status`, `ack_message`. There is no
`reply_message`; replies go out as `send_message` to the worker. Reads are
restricted to the conversation’s own mailbox.

Coordinator and workflow messages take the `coordinator` route, so a worker
wakes its coordinator and a delegation wakes the worker whatever the default
policy is. Mute, explicit Off, pause, hop budget, and `canInject` still apply.

## User interface

| Surface | Location | Notes |
| --- | --- | --- |
| Transcript, delivered mail | `MailTile` (`apps/web/src/components/chat/`) | Each injected message is a collapsed tile: an icon for its kind or notice tone, sender, subject and about three clamped lines of the body. The header is a button (`aria-expanded`); clicking it, or the clipped preview, expands the Markdown body, and the choice survives remounts and paging for the session. A batched prompt becomes one tile per message |
| Transcript, sent and read mail | `MailToolPart` (`apps/web/src/components/chat/`) | `send_message`, `reply_message`, `read_message` and a coordinator's `get_message` calls render as mail tiles, not tool rows, and stay out of the collapsed tool group (`agentMailToolCall`, `apps/web/src/lib/chat/agent-mail-tool-call.ts`). A sent tile shows the recipient and its live delivery state from the recipient's mailbox; a read tile is where pull-only mail enters the transcript. Every tile with both participants known opens their conversation |
| Messages panel | `AgentMailPanel` (`apps/web/src/components/agent-mail/`) | A right-hand sheet. The list is one row per pair that has exchanged mail (`list_agent_mail_conversations`), those needing the person first; a conversation is both directions between two participants, oldest first (`get_agent_mail_conversation`), with retry, resume, deliver-now and discard on the messages that need them. The person composes only in their own conversation with a tab. Opening a conversation marks it seen (`mark_agent_mail_conversation_seen`) |
| Title-bar button | `AgentMailButton` | Opens the panel. Its badge counts `attentionCount`: failed and budget-held deliveries and unseen external or cross-project mail (`agentMailNeedsAttention`), not the agents' own traffic |
| Per-tab banner | `AgentMailBanner` | Pending, failed, pull-only, budget or hourly-limit held; retry / resume / deliver now / discard, and View opens the tab's conversations |
| Tab menu, Agent info | `DraggableTab`, `AgentInfoButton` | One "Messages…" entry when `canPull`: the panel focused on the tab, with its delivery policy and mutes |
| Settings | Settings → Messaging | `enabled`, `paused`, `allowCrossProject`, `wakePeers`, `autonomousWakeBudget`, `hourlyWakeLimit`, `coordinatorStatusWakes` (`off` / `settled` / `stages`), `defaultInjectPolicy` (`off` / `idle`), `retentionDays` |
| Per-mailbox policy | `mute_agent_mail` | `inject`: inherit / off / idle; inbound and outbound mute |

**Conversations.** A participant is a mailbox id (`agentMailParticipantKey`), so
history survives a tab's session being replaced, or a fixed key for the person
(`user`), external clients (`external`) and a project's workflows
(`system:<projectId>`). Mail is filed only in its recipient's mailbox, so a
conversation is A's mail from B plus B's mail from A
(`apps/backend/src/core/agent-mail-conversations.ts`). It is bounded by the
same retention and per-mailbox limits as everything else; a closed tab keeps
its name from the messages it sent.

Default inject policy is **off**. Idle delivery can start a billable turn,
including on a tab that has never been prompted, so it is opt-in per
install or per mailbox for unrouted mail (from the user, and `isolated`
mail). Coordinator-route mail wakes regardless. Peer mail wakes only after
**Wake peers** is turned on: it is off by default for the same reason, since
two peers answering each other start billable turns nobody asked for, and a
missing setting normalizes to off.

The user sender bypasses the sender `canSend` check. The compose UI still
only lists pull-capable destinations, so native Cursor and Grok tabs appear
there the same way Claude and Pi do.

## Mail tools and approval settings

A worker's mail tools (`AGENT_MAIL_TOOL_NAMES`) are always allowed, whatever
the environment's approval setting: they write only to this store, are rate
limited, and are how a worker reports back. Prompting for them would leave a
delegation waiting on a person; refusing them would leave the coordinator
waiting forever. The setting still governs edits, commands and every other
tool, including Orkestrator's ticket tools. An explicit `toolPolicy` deny still
wins.

| Provider | How |
| --- | --- |
| Claude | Added to `allowedTools`, which is what `dontAsk` (deny) runs; ask/auto never prompt |
| Codex | Per-tool `approval_mode = "approve"` on the `orkestrator` server (thread config and process overrides) |
| OpenCode | `allow` rules for `orkestrator_<tool>` ahead of the ask/deny default |
| Pi | The bridge's tool gate exempts them for any approval policy |
| Grok (ACP) | A permission request for a mail tool is answered with its allow option when it names the Orkestrator server: `orkestrator__<tool>` (Grok 1.0.46's own `server__tool` form) or `_meta["x.ai/tool"]` `{ namespace: "orkestrator", name }`. Never a bare `send_message`, which any server could offer. Grok 1.0.52 asks for its `use_tool` wrapper even under `--always-approve`, so for `use_tool` the name is the wrapped `rawInput.tool_name`, or the one the bridge recorded for the same call (`orkestratorToolPermissionOption`, `acp-session.ts`). The annotation result tools (`WEB_ANNOTATION_TOOL_NAMES`) are allowed the same way |
| Cursor | Never asks |

## How each provider gets the tools

The store does not talk to vendors. Bridges (or OpenCode’s server) must
load the Agent Tools MCP URL and token. Launchers put
`ORKESTRATOR_AGENT_MCP_URL` / `ORKESTRATOR_AGENT_MCP_TOKEN` on the bridge
process. Claude, Codex, Pi, Cursor, and Grok can also take a **per-tab**
`agentMcp` on create/prompt so sibling tabs do not share one identity.

| Provider | MCP client | How Orkestrator is attached | Per-tab `agentMcp` |
| --- | --- | --- | --- |
| Claude native | Vendor SDK | `mcpServers.orkestrator` | Yes |
| Codex native | app-server config | `mcp_servers.orkestrator` | Yes |
| OpenCode native | Vendor `/mcp` API | `configureOpenCodeAgentTools` once per environment | No — environment credential |
| Pi native | Bridge-owned client (`pi-bridge/src/mcp.ts`) | Env, then per-tab `agentMcp` | Yes |
| Cursor native | SDK `AgentOptions.mcpServers` | Per-tab `agentMcp`, else process env | Yes |
| Grok native | ACP `session/new` / `session/load` | `configuredAcpMcpServers(state.agentMcp)` | Yes |
| Claude tmux | CLI `--mcp-config` | Written next to the tmux session | Session-scoped file |
| Terminal claude / codex / opencode | Whatever the user configured | Container/host may export the env vars; no Orkestrator-owned attach | No |
| Terminal cursor / grok / pi | n/a | No mailbox (not in `TERMINAL_TYPES`) | n/a |

Coordinator conversations do **not** get Agent Tools. Their bridges receive
the Control MCP URL in the same env var names, with a coordinator
credential.

`dispatchMailInject` is the same native path for every platform. There is
no Cursor- or Grok-specific inject implementation.

## Capability table

`agentMailCapabilities(tabType, agent, locked)` in
`packages/protocol/src/agent-mail.ts` is the single source. Native entries
are also published as `NATIVE_AGENT_MAIL_CAPABILITIES`. Coordinator
delegation is `mcpClient && canInject`
(`coordinator-providers.ts`).

| Context | canPull | canSend | canInject |
| --- | --- | --- | --- |
| Native Claude / Codex / OpenCode / Pi / Cursor / Grok (locked) | yes | yes | yes |
| Native, unlocked or no agent yet | no | no | no |
| Claude tmux | yes | yes | yes |
| Terminal claude / codex / opencode | yes | yes | no |
| Any other tab | no | no | no |

Unlocked native tabs (composer open, platform not chosen) are UI-only so a
half-created tab cannot consume the environment credential.

## Provider notes

**Claude native.** Reference implementation: per-turn MCP, idle inject via
`dispatchPromptInternal`, presence from the SDK activity snapshot. Qualified
for coordinator delegation.

**Codex native.** Same flags. Per-turn MCP into generated app-server
config. Qualified for coordinator delegation.

**OpenCode native.** Flags are on. MCP is registered once against
`opencode serve` with an environment-scoped token. That is enough when the
environment has a single pull-capable tab; with several, the agent must
pass `tabId`. There is no per-turn MCP attach, which is why OpenCode is
unqualified for workflow-result *tools* — that is a different feature, not
a mail gap.

**Pi native.** Flags are on. Pi's SDK sessions load no MCP client; the bridge
owns one and registers Orkestrator tools through an inline extension.
Terminal `pi` tabs are not mailboxes. Qualified for coordinator
delegation.

**Cursor native.** Flags are on. The SDK bridge injects `orkestrator` from
a per-tab `agentMcp` or, as fallback, process env. A rotated tab token
detaches and resumes the same SDK agent; the bearer is never persisted.
Qualified for coordinator delegation at `provider-configured`.

**Grok native.** Flags are on. ACP `session/new` and `session/load` pass
`configuredAcpMcpServers(state.agentMcp)`. A rotated tab token closes that
session’s CLI child and reloads it; it is never written into process env.
Qualified for coordinator delegation when the host safety setting admits
`advisory`.

**Claude tmux.** Pull, send, and inject are on. Inject submits through the
tmux prompt queue (`prompt-queue-drainer.ts`) and does not restart a
stopped pane. MCP is a `--mcp-config` file for that session.

**Terminal claude / codex / opencode.** Addressable, pull and send on,
inject off by design — there is no durable activity signal safe enough to
wake a PTY. Whether the CLI actually has Orkestrator MCP depends on the
user’s own config plus exported env vars. That is a weaker, unowned path.

## Settings that apply to every provider

Defaults (`DEFAULT_AGENT_MESSAGING_SETTINGS`):

- `enabled: true`
- `paused: false`
- `allowCrossProject: false`
- `defaultInjectPolicy: "off"`
- `wakePeers: false`
- `autonomousWakeBudget: 16`
- `hourlyWakeLimit: 40`
- `coordinatorStatusWakes: "settled"`
- `retentionDays: 14`

Disable messaging and the Agent Tools server omits the mail tools.
Pause accepts new mail and stops the drain. Cross-project discovery is
off unless the setting is on; those messages still never inject.

## Feature matrix

Legend: **Y** = implemented and gated on. **N** = not available. **P** =
partial (code path exists but identity, policy, or ownership is weaker
than the complete row). **—** = not applicable.

“Complete” is the first data column: the union of what the store, Agent
Tools, idle inject, and routed wake already implement for a
locked native mailbox.

### Native agent tabs (`agent-native`)

| Feature | Complete | Claude | Codex | OpenCode | Pi | Cursor | Grok |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Durable mailbox | Y | Y | Y | Y | Y | Y | Y |
| Directory / compose target (`canPull`) | Y | Y | Y | Y | Y | Y | Y |
| Agent send / reply | Y | Y | Y | Y | Y | Y | Y |
| Agent pull / read / ack | Y | Y | Y | Y | Y | Y | Y |
| Sent-message status | Y | Y | Y | Y | Y | Y | Y |
| Idle inject (carrier → new turn) | Y | Y | Y | Y | Y | Y | Y |
| Presence-gated drain | Y | Y | Y | Y | Y | Y | Y |
| Orkestrator MCP loaded | Y | Y | Y | Y | Y | Y | Y |
| Mail tools actually succeed | Y | Y | Y | Y | Y | Y | Y |
| Per-tab MCP credential | Y | Y | Y | P | Y | Y | Y |
| User inbox + banner | Y | Y | Y | Y | Y | Y | Y |
| Coordinator delegation | Y | Y | Y | Y | Y | Y | Y |
| Routed wake (coordinator, peer) | Y | Y | Y | Y | Y | Y | Y |

OpenCode’s **P** on per-tab credentials: environment-level MCP is enough
for a single native tab; several pull-capable tabs in one environment must
claim `tabId`.

### Other tab kinds and callers

| Feature | Complete native | Claude tmux | Term. claude/codex/opencode | Term. cursor/grok/pi | Control MCP external | User UI |
| --- | --- | --- | --- | --- | --- | --- |
| Addressable mailbox | Y | Y | Y | N | — | — |
| Agent pull / send | Y | Y | Y | N | N | — |
| Idle inject | Y | Y | N | N | N (never) | via policy / retry |
| Orkestrator-owned MCP attach | Y | Y | P | N | operator credential | — |
| Coordinator delegation | Y | — | — | — | — | — |

Terminal cursor/grok/pi are not in `TERMINAL_TYPES`, so they never enter
the store. Cursor has no terminal product path.

## Gaps versus complete

These are the differences that matter. They are flags and wiring, not
missing store features.

1. **Terminal claude / codex / opencode cannot be woken.** Pull and send
   are on so a CLI that has MCP can participate; inject is off because
   there is no safe idle signal for a PTY. That is a designed subset, not
   an unfinished native port.

2. **Terminal pi / grok are not addressable.** They do not get a mailbox.
   Cursor has no terminal mode.

3. **Control MCP external send is inbox-only.** By design: an operator
   token must not start an agent turn.

4. **OpenCode MCP is environment-scoped.** Complete for one native tab;
   weaker identity when several pull-capable tabs share the process.

Nothing in the store is Claude-specific. A provider that can load MCP,
ack a carrier, and accept `dispatchMailInject` is complete once the
capability row says so.

## Where to look

| Topic | Path |
| --- | --- |
| Protocol, flags, carrier | `packages/protocol/src/agent-mail.ts` |
| Persist, send, inject policy | `apps/backend/src/core/storage-agent-mail.ts` |
| Drain, batch, presence cache | `apps/backend/src/core/agent-mail-service.ts` |
| Native inject / presence | `apps/backend/src/core/native-agent-service.ts` |
| Tmux inject | `apps/backend/src/core/prompt-queue-drainer.ts` |
| Agent Tools mail | `apps/backend/src/core/agent-tools-messaging.ts` |
| Control MCP mail | `apps/backend/src/core/control-mcp-server.ts` |
| Delegation = MCP ∧ inject | `apps/backend/src/core/coordinator-providers.ts` |
| UI commands | `apps/backend/src/core/commands-registry-mail.ts` |
| Conversations (pairs) | `apps/backend/src/core/agent-mail-conversations.ts` |
| Settings / panel / banner | `apps/web/src/components/settings/MessagingSettings.tsx`, `apps/web/src/components/agent-mail/` |
| Transcript tiles | `apps/web/src/lib/chat/client-only-messages.ts` (carrier → rows), `apps/web/src/lib/chat/agent-mail-tool-call.ts` (mail tool calls), `apps/web/src/components/chat/MailTile.tsx`, `MailToolPart.tsx` |
| Main / side coordinator, respawn | `apps/backend/src/core/coordinator-service.ts`, `packages/protocol/src/coordinator.ts` |
| Coordinator status wakes | `apps/backend/src/core/coordinator-status-wakes.ts` |
| Multi-actor scenarios | `apps/backend/src/core/agent-mail-scenarios.test.ts` on `agent-mail-world-test-support.ts` |
