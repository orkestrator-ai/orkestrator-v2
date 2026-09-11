# Agent Messaging — Usability and Orchestration Plan

| Field | Value |
| --- | --- |
| Status | Proposed. Follows the shipped v1 described in `agent-messaging-plan.md` |
| Scope | Identity, discovery, delivery visibility, UI surfaces, sweep efficiency |
| Date | 2026-09-06 |

This plan addresses the gaps found in the review of the shipped messaging
system. The backend contract from `agent-messaging-plan.md` stays: mailboxes
are `(environmentId, tabId)` with a backend-minted incarnation, pull is the
default, injection is opt-in and idle-only, and every state transition is
persisted before it is announced. Nothing here changes a trust class, a loop
breaker, or the carrier's safety properties. The work is about making the
system discoverable by agents, legible to users, and cheap to run.

The phases are ordered so that each one ships on its own and the earlier
phases remove the most friction. Phase 1 is the one that makes the feature
usable at all from an agent's point of view.

---

## 0. Problems being solved

Numbered so later sections can refer to them.

| # | Problem | Where |
| --- | --- | --- |
| P1 | An agent is never told its own tab id, yet every messaging tool requires `tabId`/`fromTabId` and rejects any other value. | `agent-tools-messaging.ts:27`, `agent-tools.ts:247` |
| P2 | Native bridges hold one **environment-scoped** credential. Messaging tools are registered only when the environment has exactly one pull-capable mailbox (`resolveUniqueAgentMailPullTabId`). Two native tabs, or one native plus one tmux tab, and neither gets messaging tools. Because the tool server is built per request, tools appear and vanish as sibling tabs open and close. | `agent-tools.ts:238`, `commands-servers.ts:898`, `commands-environment.ts:1646` |
| P3 | The directory names a tab by pane-layout `displayTitle`, which ordinary native tabs never set. Users see UUIDs where the tab strip shows "Claude 2" or the session title. | `storage-agent-mail.ts:353`, `DraggableTab.tsx:182` |
| P4 | Browser, file, and plain terminal tabs are addressable. They appear in the compose list and get a hover inbox icon, but no agent can ever read what is sent there. | `storage-agent-mail.ts:109`, `AgentMailButton.tsx:235` |
| P5 | No sent view, no thread view, no reply from the UI. | `AgentMailButton.tsx` |
| P6 | Pending and failed injections are counted in the summary but never rendered outside the dropdown. No toast, badge, or chat-tab hint. | `EnvironmentItem.tsx:235`, `SortableProjectGroup.tsx:133` |
| P7 | One unread counter serves two readers. Agent ack clears the user's badge; user open clears it before the agent pulls. | `storage-agent-mail.ts:461` |
| P8 | Tab-level inbox cannot compose; no "message this tab" entry point. | `AgentMailButton.tsx:222`, `DraggableTab.tsx:361` |
| P9 | Presence is always `unknown` for a running environment and is never shown. | `storage-agent-mail.ts:469` |
| P10 | Mute and inject policy controls live inside an expanded message; a mailbox with no messages cannot be configured. | `AgentMailButton.tsx:330` |
| P11 | Held injections churn: claim, hold, write back, announce, every 2 s sweep, for as long as the recipient is busy or has a draft. | `agent-mail-service.ts:104`, `storage-agent-mail.ts:1257` |
| P12 | `synchronizeAgentMailboxes` reloads projects, environments, every pane layout, and coordinators on every read and every sweep. | `storage-agent-mail.ts:304` |
| P13 | A typed but unsent compose draft holds delivery with no signal to either side. | `native-agent-service-prompt.ts:172`, `prompt-queue-drainer.ts:134` |

---

## 1. Phase 1 — Identity: agents know who they are

Goal: an agent can call `check_inbox` on its first turn without guessing, in
every environment shape, and cannot be locked out by a sibling tab.

### 1.1 Resolve identity from the credential, not from the input

Make `tabId` and `fromTabId` optional on every messaging tool. When omitted,
the server fills them from the scope. Keep them accepted for one release so
prompts and cached tool schemas keep working, but the description says the
field is optional and defaults to the caller.

`assertCallerMailbox` rules after the change:

- Tab-scoped credential (tmux tabs, and native tabs after 1.3): the caller is
  the credential's tab. A supplied value that differs is `capability-denied`,
  as today.
- Environment-scoped credential with exactly one pull-capable mailbox: the
  caller is that mailbox, exactly as today.
- Environment-scoped credential with several pull-capable mailboxes: the
  caller **must** supply `tabId`, and it must name a live, pull-capable,
  non-tombstoned mailbox in that environment. Any such tab is accepted.

The last rule replaces the `requireUniqueTab` cliff. The credential already
authorizes the whole environment; refusing to let it act as any of its own
tabs adds no security and removes the feature. Sibling tabs share a project,
an environment, a worktree, and a user, so the trust class of a message is
identical whichever tab sends it. Document this in `control-mcp.md` as the
environment credential's boundary.

Files: `apps/backend/src/core/agent-tools-messaging.ts`,
`apps/backend/src/core/agent-tools.ts`,
`apps/backend/src/core/storage-agent-mail.ts` (`resolveUniqueAgentMailPullTabId`
becomes `listAgentMailPullTabIds(environmentId)`).

### 1.2 Tell the agent its address

Three places, so the information survives context compaction:

1. **MCP `instructions`.** The server is built per request with the scope in
   hand, so the string can be exact. Tab-scoped: "Your mailbox address is
   environment `<id>` tab `<id>` (`<display name>`)." Environment-scoped with
   several tabs: "This environment has these agent mailboxes: … Pass `tabId`
   to say which one you are; use the one whose title matches your session."
2. **`check_inbox` and `list_mailboxes` results** gain an `identity` object
   `{ environmentId, tabId, title, resolved: "credential" | "unique" | "claimed" }`
   and every directory row gains `self: boolean`.
3. **The carrier** payload gains `to: { environmentId, tabId }` so an injected
   message tells the recipient the address it was delivered to. Update
   `renderAgentMailCarrier` and `createPeerMailNativeMessageFromCarrier`, which
   must keep accepting payloads without `to`.

Always register messaging tools when messaging is enabled. Whether the caller
can act is decided per call with a structured error, not by hiding the tools.
An agent that cached the tool list at session start must not find it stale.

Files: `agent-tools.ts` (instructions), `agent-tools-messaging.ts`,
`packages/protocol/src/agent-mail.ts`,
`apps/web/src/lib/chat/client-only-messages.ts`.

### 1.3 Per-session credentials where the platform allows it

This is the proper fix for P2 and is worth doing after 1.1 makes the system
usable. It gives native tabs the same tab-scoped credential tmux tabs already
have.

- **Claude bridge.** The SDK takes `mcpServers` per query. Have the backend
  issue a tab-scoped credential at session create/attach and pass it in the
  prompt request body; the bridge builds the `orkestrator` server entry from
  that instead of process env. `getOrkestratorAgentMcpServer` keeps the env
  path as the fallback for older backends.
- **Codex bridge.** `thread/start` accepts per-thread `config` overrides.
  Verify that `mcp_servers.orkestrator.http_headers` (or the equivalent key in
  the pinned app-server) is honoured per thread. If it is, issue per-thread
  credentials the same way. If not, Codex stays on the 1.1 environment rule.
- **OpenCode.** Configuration is per server instance, so it stays on the 1.1
  environment rule until OpenCode offers per-session MCP headers.

Credential lifecycle: issue on session create, revoke on tab close through the
existing tab-teardown reconciler, reissue on backend restart via the same
attach path that already re-sends the prompt.

Files: `apps/backend/src/core/native-agent-service-provider.ts`,
`apps/backend/src/core/agent-tools.ts` (`connection` with `tabId` is already
supported), `bridges/claude-bridge/src/services/mcp-config.ts`,
`bridges/claude-bridge/src/routes/session.ts`,
`bridges/codex-bridge/src/codex-config.ts`.

### 1.4 Acceptance

- Two Claude tabs and one tmux tab in one environment: all three can list,
  check, send, and reply on their first turn without a hint from the user.
- A fresh Claude tab reads its address from the MCP instructions and calls
  `check_inbox` with no arguments successfully.
- Closing a sibling tab does not change the tool list another tab sees.
- Tests: extend `agent-tools.test.ts` with a multi-tab environment, a claimed
  tab that is not pull-capable (`capability-denied`), a claimed tab in another
  environment (`capability-denied`), and identity echo in results.

---

## 2. Phase 2 — Naming and addressability

Goal: every entry in the directory reads the way the tab strip reads, and
nothing that cannot receive is offered as a destination.

### 2.1 One naming function, used everywhere

The tab strip resolves a name in this order: workflow label, custom session
name, native session title, `displayTitle`, platform label plus tab number.
Mailbox synchronization sees only `displayTitle`.

- Persist the resolved display name into the mailbox record. The backend has
  the session name (sessions store) and the native session title (projection
  snapshot title, see `native-agent-service-projection.ts:1430`), so it can
  compute the same order. Extract the order into a small pure helper in
  `packages/protocol` (`resolveTabDisplayName`) and use it from both
  `DraggableTab.tsx` and `synchronizeAgentMailboxes`.
- Tab numbers are per-environment and per-pane; use the environment-wide
  ordinal the sidebar already uses, and include the platform: "Claude 2",
  "Codex 1 · Fix parser".
- Re-sync the mailbox when a session title changes. Announce `agent-mail` for
  that mailbox so the directory and inbox headers refresh.

The carrier's `from.title` and the transcript card use the same name, so a
recipient sees "Message from Claude 2 · Fix parser", not a UUID.

### 2.2 Directory rows carry what a sender needs

Extend `MailboxDescriptor` with `displayName`, `tabOrdinal`, and keep
`agent`, `kind`, `capabilities`, `presence`. In the UI:

- Row label: platform icon, display name, environment, project (project only
  when cross-project is enabled).
- Right-hand status chip from presence (Phase 4) and policy: "pull only",
  "deliver when idle", "muted".
- Sort: current environment first, then project, then environment, then
  ordinal.

### 2.3 Only agents are destinations

Mailboxes for `browser`, `file`, and plain terminal tabs stop being created.
They cannot pull, cannot send, and cannot inject, so a message to one is a
note only its sender can read. Remove `UI_TYPES` from `mailboxKind`, keep
`TERMINAL_TYPES` only for the tab types whose CLI actually receives the MCP
server (`claude`, `codex`, `opencode` terminal tabs can pull).

Existing mailboxes of the removed kinds are tombstoned by the next sync, which
already settles pending mail as `undeliverable`.

The compose dropdown filters on `capabilities.canPull`; the tab-strip inbox
icon mounts only when the tab's mailbox can pull.

### 2.4 Acceptance

- Directory and inbox headers show the same name as the tab strip for a
  renamed session, an auto-titled session, and an untitled session.
- A browser tab has no inbox icon and is not listed as a destination.
- Tests: `storage-agent-mail.test.ts` naming order; `AgentMailButton.test.tsx`
  destination filtering; a protocol test for `resolveTabDisplayName`.

---

## 3. Phase 3 — Delivery state where the work happens

Goal: both principals can see what happened to a message without opening the
global dropdown.

### 3.1 Split the receipts

Replace the single `unreadCount` with three fields on the summary entry and
descriptor:

- `userUnseenCount` — messages without `userSeenAt`.
- `agentUnackedCount` — messages without `ackedAt` and not discarded.
- `failedCount` and `pendingCount` — already present as `failedInjectCount`
  and `pendingInjectCount`; keep them.

Badges use `userUnseenCount` only. The message card shows two receipt rows:
"Seen by you" and "Acknowledged by agent", each with a timestamp or "not
yet". Keep `unreadCount` on the wire for one release as an alias of
`userUnseenCount`.

### 3.2 Recipient chat-tab banner

A slim, dismissable strip above the transcript in `AgentNativeTab` and the
tmux terminal container, driven from the mail store's summary entry for the
tab's mailbox:

- pending > 0 and policy idle: "1 message waiting · delivers when this agent
  is idle" with a "Deliver now" action that dispatches immediately if the tab
  is idle, else explains the hold reason.
- pending > 0 and policy off: "1 message in inbox · pull only" with "Open
  inbox" and "Switch to deliver when idle".
- failed > 0: amber "Delivery failed: <reason>" with "Retry" and "Discard".
- held for loop budget: "Delivery paused: loop budget" with "Resume".

The banner reads only the store and rehydrates from `agent-mail-summary` on
mount, so it is correct after a reload and for an inactive tab that was
messaged while unmounted.

### 3.3 Sender feedback

- `sendAgentMail` returns the placement; the UI already toasts on bounce.
  Also toast on a later `inject_failed` transition for a message the user
  sent from this client. Track sent ids in the mail store for the session
  and compare on each summary refresh.
- Sidebar: environment and project rows show an amber dot when any mailbox
  under them has `failedCount > 0`, in addition to the cyan unseen count.

### 3.4 Sent and threads

- Add `listAgentMailSentByMailbox(environmentId, tabId)` in storage. Sent
  messages already live in recipients' mailboxes; the query scans mailboxes
  and filters on `from`. Bound it by the retention window and the per-mailbox
  message cap, which keeps it O(mailboxes × 200).
- Inbox UI gets an "Inbox / Sent" toggle per mailbox and groups rows by
  `threadId`, newest thread first, showing the last message and a count.
- The message card gets "Reply". For a tab sender the reply goes through
  `send_agent_mail` with `replyToMessageId`, which the user-kind sender is
  allowed to use today (participation checks apply only to tab senders).
  Destination is prefilled from the parent's `from`.

### 3.5 Acceptance

- Send a message to an idle native tab with policy off, switch environments,
  return: the banner shows one message waiting, and the tab's badge shows one
  unseen. Reload: same state.
- Switch that mailbox to deliver-when-idle from the banner: the message
  injects, the transcript shows the card, the banner clears, the badge stays
  until the user opens the message.
- Cause an `inject_failed` (stop the environment mid-dispatch in a test):
  amber badge in the sidebar, banner with Retry, toast for the sender.
- Tests: `AgentNativeTab.test.tsx` banner states from store fixtures;
  `agentMailStore.test.ts` sent tracking; storage test for sent listing.

---

## 4. Phase 4 — Presence and policy at the mailbox level

### 4.1 Real presence

`AgentMailService` already reads `sessionActivitySnapshot` and tmux status
during the sweep. Have it write a presence map (`mailboxId → presence, at`)
into an in-memory service field, and have the descriptor path consult it
through a small `presenceProvider` injected into `StorageAgentMail`. Values:
`idle`, `working`, `waiting` (pending approval or question), `draft` (compose
draft holds delivery), `environment_stopped`, `environment_unready`,
`tab_closed`, `unknown`. Never persisted; a restart resets to `unknown` until
the next sweep.

The compose button text becomes truthful: "Send · recipient idle, delivers
now", "Send · recipient busy, delivers when idle", "Send · pull only".

### 4.2 Policy controls move to the mailbox header

In both dropdown variants, the header for a selected mailbox shows: inject
policy select, mute inbound, mute outbound, and the effective policy source
("inherits global: off"). Remove the controls from the expanded card. A
mailbox with zero messages can now be configured.

Add "Message this tab…" and "Inbox settings…" to the tab context menu and to
the agent-info popover. Both open the tab-variant dropdown in compose or
settings mode. The tab-variant dropdown gains the compose form with the
destination fixed to that tab.

### 4.3 Surface the draft hold (P13)

When the drainer holds for `draft`, presence is `draft`, the banner in the
recipient tab says "Delivery waiting: you have unsent text in the composer",
and the sender's status line says "recipient is composing". No behaviour
change to the hold itself.

---

## 5. Phase 5 — Sweep efficiency

Goal: an idle system with pending mail does no periodic writes, and a busy
system does not re-derive the directory every two seconds.

### 5.1 Event-driven mailbox synchronization

- Run `synchronizeAgentMailboxes` on `pane-layout`, `environment`, `project`,
  session-title, and coordinator resource changes, debounced by 250 ms per
  environment, plus once at init. The storage layer already announces these
  through `announce`; subscribe inside `AgentMailService` (or a small
  `AgentMailboxObserver`) rather than in storage.
- Remove the unconditional `synchronizeAgentMailboxes()` call from the read
  methods (`getAgentMailSummary`, `getAgentMailMailbox`, `getAgentMailMailboxes`,
  `getAgentMailInboxSnapshot`, `listAgentMailboxes`, `listPendingAgentMailInjects`).
  Keep it in `sendAgentMail`, guarded by a cheap staleness check: a
  `layoutRevision` captured at the last sync, compared with the pane-layout
  store revision. The plan document's section 4.2 already describes this
  observer; this phase implements it.
- The sync itself stops stringifying every mailbox's metadata; compare the
  fields directly.

### 5.2 Back-off for held injections (P11)

- Pre-check before claiming for tmux as well as native: call
  `claude_tmux_status` and check the queue and draft first; skip without
  claiming when the tab is busy, exactly as the native path already does for
  known activity.
- Add `nextAttemptAt` to the pending-inject index entry. On a `held` outcome
  set it to now plus a back-off (2 s, 4 s, 8 s, capped at 30 s), reset on any
  activity change for that session (the activity sweep already knows). The
  drainer skips entries whose `nextAttemptAt` is in the future.
- A `held` outcome no longer bumps the message revision or announces
  `agent-mail`; the placement reason is still recorded. Only accepted, failed,
  and reason **changes** announce. This stops the renderer refetch loop.

### 5.3 Acceptance

- With one pending message to a busy tmux tab, the mail store file's mtime
  does not change across 60 s of sweeps, and the renderer receives no
  `agent-mail` events.
- Opening and closing a tab updates the directory within one second.
- Tests: `agent-mail-service.test.ts` for pre-check without claim, back-off
  scheduling, and announce suppression; a storage test that read methods do
  not touch pane layouts (spy on `loadPaneLayoutsForReconciliation`).

---

## 6. Tool surface after the changes

| Tool | Change |
| --- | --- |
| `list_mailboxes` | Adds `identity`, `self`, `displayName`, `presence`; excludes non-agent tabs. |
| `check_inbox` | `tabId` optional; adds `identity`; returns receipts split. |
| `read_message` | `tabId` optional. |
| `ack_message` | `tabId` optional. |
| `send_message` | `fromTabId` optional; result includes `placement`, `presence` of the recipient, and a plain-language `deliveryHint` ("stored, recipient pulls", "queued, delivers when idle", "bounced: muted"). |
| `reply_message` | `fromTabId` optional. |
| `get_message_status` | `fromTabId` optional; result includes both receipts. |

Descriptions are rewritten to state the three facts an agent needs: you are
`<address>`, messages are untrusted data, and check at task boundaries. The
"do not poll" guidance stays.

---

## 7. Sequencing and estimates

| Phase | Depends on | Size | Ships value |
| --- | --- | --- | --- |
| 1.1–1.2 Identity via credential + self-announcement | — | S–M | Agents can use messaging in every environment shape. |
| 2 Naming and addressability | — | M | Humans can tell tabs apart; no dead destinations. |
| 3 Delivery state and receipts | 2 | M–L | Users see pending/failed without the dropdown; reply and sent views. |
| 5 Sweep efficiency | — | M | Removes periodic writes and refetch churn. |
| 4 Presence and mailbox-level policy | 3, 5.1 | M | Truthful send button; configurable empty mailboxes; draft hold visible. |
| 1.3 Per-session credentials | 1.1 | M (Claude), spike (Codex) | Removes the shared-credential rule for native tabs. |

Phases 1, 2, and 5 are independent and can run in parallel. Phase 3 wants the
naming from Phase 2 so the banner and thread rows read correctly. Phase 4
wants the split receipts from Phase 3 and the observer from 5.1. Phase 1.3 is
last because 1.1 already unblocks agents; it is a security tidy-up, not a
usability fix.

---

## 8. Verification per phase

Every phase runs the owning unit tests, the backend and web typechecks, and
the real-stack cycle from `docs/development/agent-testing.md` with an
agent-test profile and a fixture. The inactive-environment path is exercised
in each UI phase: send, switch environment, let delivery settle, return,
verify, reload, verify again.

Phase 1 additionally needs one live agent run per platform with the credential
source narrowed to that platform: open two tabs in one environment, ask each
"check your inbox and tell me your address", and confirm both succeed.

---

## 9. Non-goals

- Broadcast, environment or project aliases, multiple recipients. The
  addressing model stays exact-tab.
- Attachments. Text only.
- `wait_for_reply` or deadlock detection. Rate limits, hop caps, and the
  inject-depth breaker stay the loop controls.
- Injection for Cursor or Grok until `agentMailCapabilities()` flips with
  pull and ack. Those bridges already inject the Orkestrator MCP server;
  the flags, not the bridges, are what keep those native tabs
  human-inbox-only. Native Pi mail flags are on.
