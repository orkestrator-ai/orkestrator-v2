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
| User inbox | Global compose/read UI, per-tab banner, mute and inject-policy overrides |
| Coordinator round-trip | Authenticated same-project mail can wake both coordinator and worker even when the default inject policy is off |

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

Review and workflow tabs (`claude-build`, `looped-review`, `multi-review`)
are never mailboxes.

**Actors.** Every message records who sent it:

| `from.kind` | Who | Typical path |
| --- | --- | --- |
| `tab` | An agent mailbox | Agent Tools MCP |
| `coordinator` | A project coordinator conversation | Control MCP with a coordinator credential |
| `user` | The human in the Orkestrator UI | `send_agent_mail` |
| `system` | A backend workflow | Completion notices with a stable outbox id |
| `external` | Control MCP operator token | `send_external_agent_mail` — inbox only |

**Trust.** Derived at send time from sender and recipient project/environment:

`user` · `same-environment` · `same-project` · `cross-project` · `external`

Cross-project and external mail is stored and never auto-injected. The
carrier text tells the model the payload is untrusted.

**Placements.**

| Placement | Meaning |
| --- | --- |
| `stored` | Durable; recipient must pull, or a later promotion/retry may schedule inject |
| `pending-inject` | Claimed for the drain |
| `injected` | Carrier was accepted as a prompt |
| `inject-held` | Held for a busy recipient, a still-open worker delegation, or the hop budget |
| `inject_failed` | Dispatch rejected or ambiguous; UI can retry |
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
- Store file 32 MiB
- Thread / autonomous hop budget 8
- Default retention 14 days (1–365)
- Inject batch: 10 messages or 128 KiB of rendered carriers per wake
- Agent Tools rate limits: read 30/min and 2 000/day; send 20/min and 200/day, per `(environment, tab, kind)`

There are no attachments, no multicast, and no search-over-bodies API. One
`requestId` per sender scope is idempotent; retrying the same id with a
different body is `idempotency-conflict`.

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
                              held     --> inject-held (backoff)
                              failed   --> inject_failed
```

`shouldScheduleInject` (`storage-agent-mail.ts`) is true only when all of
these hold:

1. Global messaging is enabled (and not relevantly paused for the schedule
   itself — pause still accepts mail).
2. Recipient inject policy is `idle`, **or** this is a coordinator exchange
   (same-project mail from/to a coordinator while the mailbox still
   `inherit`s the default).
3. Inbound is not muted.
4. Trust is not `cross-project` or `external`.
5. Inject depth is 0, unless it is a coordinator exchange.
6. Thread / pair depth is below 8.
7. Recipient `canInject`.
8. The sender is not a worker still held by an open delegation to this
   coordinator conversation.

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

**Presence.** Native inject uses `mailInjectPresence` (queue, compose draft,
pending dispatch, environment readiness, then turn activity). Drain admits
`idle` and `unknown` (never-prompted tab). The dispatch fence is stricter:
background `working` holds the claim. Tmux requires observed idle and will
not restart a stopped session. Terminal-kind mailboxes are never drained.

Interrupted native injects are reconciled on backend start against the
session’s dispatch journal (`reconcileMailInject`). Ambiguous outcomes fail
closed as `inject_failed` rather than double-sending.

## Three MCP surfaces

The tool *names* overlap. The credentials do not.

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

If the resolved mailbox has `canPull: false`, every tool returns
`capability-denied`. Connecting the HTTP MCP server is not the same as
having a working mailbox.

### Control MCP — operator

`apps/backend/src/core/control-mcp-server.ts`, documented in
[`control-mcp.md`](./control-mcp.md).

An operator token can `list_mailboxes` and `send_message`. Those sends are
always `external` and **never injected**. The human reads them in the
global inbox.

### Control MCP — coordinator credential

The same HTTP endpoint, a different bearer token, bound to one project,
workspace, conversation, and mailbox incarnation.

Coordinator mail tools: `list_mailboxes`, `send_message`, `read_messages`,
`get_message`, `get_message_status`, `ack_message`. There is no
`reply_message`; replies go out as `send_message` to the worker. Reads are
restricted to the conversation’s own mailbox.

Authenticated same-project coordinator and system messages bypass an
inherited “inject off” default so a worker can wake the coordinator and a
delegation can wake the worker. Mute, pause, hop budget, and `canInject`
still apply.

## User interface

| Surface | Location | Notes |
| --- | --- | --- |
| Settings | Settings → Messaging | `enabled`, `paused`, `allowCrossProject`, `defaultInjectPolicy` (`off` / `idle`), `retentionDays` |
| Global inbox | `AgentMailButton` | Compose, sent, seen; destinations filtered to `canPull` |
| Per-tab banner | `AgentMailBanner` | Pending, failed, pull-only, loop-budget held; retry / discard |
| Tab menu | `DraggableTab` | “Message this tab” / inbox settings when `canPull` |
| Agent info | `AgentInfoButton` | Mail section when `canPull` |
| Per-mailbox policy | `mute_agent_mail` | `inject`: inherit / off / idle; inbound and outbound mute |

Default inject policy is **off**. Idle delivery can start a billable turn,
including on a tab that has never been prompted, so it is opt-in per
install or per mailbox.

The user sender bypasses the sender `canSend` check. The compose UI still
only lists pull-capable destinations, so native Cursor and Grok tabs appear
there the same way Claude and Pi do.

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

**Pi native.** Flags are on. The vendor SDK has no MCP client; the bridge
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
- `retentionDays: 14`

Disable messaging and the Agent Tools server omits the mail tools.
Pause accepts new mail and stops the drain. Cross-project discovery is
off unless the setting is on; those messages still never inject.

## Feature matrix

Legend: **Y** = implemented and gated on. **N** = not available. **P** =
partial (code path exists but identity, policy, or ownership is weaker
than the complete row). **—** = not applicable.

“Complete” is the first data column: the union of what the store, Agent
Tools, idle inject, and coordinator exchange already implement for a
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
| Coordinator inject exception | Y | Y | Y | Y | Y | Y | Y |

OpenCode’s **P** on per-tab credentials: environment-level MCP is enough
for a single native tab; several pull-capable tabs in one environment must
claim `tabId`.

### Other tab kinds and callers

| Feature | Complete native | Claude tmux | Term. claude/codex/opencode | Term. cursor/grok/pi | Control MCP external | User UI |
| --- | --- | --- | --- | --- | --- | --- |
| Addressable mailbox | Y | Y | Y | N | — | — |
| Agent pull / send | Y | Y | Y | N | N | — |
| Idle inject | Y | Y | N | N | N (never) | via policy / retry |
| Orkestrator-owned MCP attach | Y | Y | P | N | operator token | — |
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
| Native inject / presence | `apps/backend/src/core/native-agent-service-prompt.ts` |
| Tmux inject | `apps/backend/src/core/prompt-queue-drainer.ts` |
| Agent Tools mail | `apps/backend/src/core/agent-tools-messaging.ts` |
| Control MCP mail | `apps/backend/src/core/control-mcp-server.ts` |
| Delegation = MCP ∧ inject | `apps/backend/src/core/coordinator-providers.ts` |
| UI commands | `apps/backend/src/core/commands-registry-mail.ts` |
| Settings / inbox / banner | `apps/web/src/components/settings/MessagingSettings.tsx`, `apps/web/src/components/agent-mail/` |
