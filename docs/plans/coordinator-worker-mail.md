# Agent mail that wakes: coordinator ↔ worker and peer ↔ peer

Status: Done — everything below is implemented (2026-10-15), rebased on
`origin/main` at `e43dd585`. Remaining: live runs against real providers, which
the user is doing. The agent registry stays event-less by design: consumers
re-read it on the events it is derived from (see
[`agent-registry.md`](../architecture/agent-registry.md)).

## Third round (2026-10-15)

Rebased onto `origin/main` (13 commits; the Claude bridge's allowlist moved to
`session-manager-prompt-query.ts`). Then:

- Follow-ups to a busy worker join its open delegation (one wake for both).
- Coordinator mail for a stopped local worker starts it; a stopped container
  notifies the coordinator; `send_message` carries a `deliveryNote`.
- Delegation sweep reads the turn view; reports held across the
  notice race are released on the sweep.
- A new main collects the closed main's unhandled mail.
- Grok approval matcher checked against Grok 1.0.46's `server__tool` naming and
  `x.ai/tool` namespace metadata.
- Scenario suite: follow-up joining, held report surviving a main close,
  stopped worker, peer never starting an environment, backend restart.

## Second round (2026-10-15)

Decided with the user after steps 1–3:

- **One main coordinator plus side agents** replaces up to 16 equal
  conversations. Workers report to `"coordinator"`, which always resolves to
  the current main; closing the main and then receiving mail starts a new main
  with the default agent, which takes over the open delegations. Side agents
  (Side 1, Side 2…) read the project and mail the main only. Done — see
  [`coordinator.md`](../architecture/coordinator.md#one-main-coordinator-and-side-agents).
  Confirmed: side agents launch nothing; legacy conversations migrate with the
  selected one as main and the rest as sides.
- **Agent registry**, app level: every agent tab and its state, for the
  coordinator (`list_agents`), the sidebar hover card, and services. Done as a
  snapshot service — see [`agent-registry.md`](../architecture/agent-registry.md).
  Not yet: a push event, and moving the sidebar icon onto it.
- **No manual retries**: refused dispatches retry on a schedule; ambiguous
  ones are confirmed against the dispatch journal first. Done (step 6, first
  half).
- **Pi and OpenCode coordinator tool gates** (step 7). Done; the coordinator
  tool list is shared in the protocol and tested against the server.
- **Addressing** (step 4). Done: `"coordinator"`, optional `toTabId`.
- **Multi-actor test set** (part of step 9):
  `apps/backend/src/core/agent-mail-scenarios.test.ts`. Live per-provider runs
  remain.
- **Approval settings** (step 8): decided — always allow Orkestrator's mail
  tools on workers. Done for Claude, Codex, OpenCode and Pi; Grok matches
  server-qualified names and needs a live check
  ([`agent-messaging.md`](../architecture/agent-messaging.md#mail-tools-and-approval-settings)).
- Side-agent scope and migration were confirmed as built.
Inventory:
[`docs/architecture/agent-messaging.md`](../architecture/agent-messaging.md),
[`docs/architecture/coordinator.md`](../architecture/coordinator.md).

## Goal

A coordinator conversation and every environment it created form one
**family**. Every other same-project agent tab is a **peer**. Two kinds of
mail wake their recipient automatically:

| Route | Wakes recipient? |
| --- | --- |
| Coordinator ↔ a worker it created (family) | Yes |
| Peer ↔ peer (neither tab is in a coordinator-created environment), same project | Yes |
| Family worker ↔ family worker (siblings) | No — stored; the coordinator is the hub |
| Family worker ↔ peer, or ↔ another coordinator | No — stored |
| Cross-project, external (operator token) | Never (unchanged) |

For the routes that wake:

1. The coordinator can mail an environment it created by environment id, and the
   worker can mail its coordinator, without either side having to discover a
   tab id.
2. Every message is injected into the recipient automatically when it is idle,
   with no Resume, Retry, Deliver-now, or policy change by the user, whatever
   the global `defaultInjectPolicy` is.
3. No mail or control tool used for that exchange raises an approval prompt or
   is silently refused, on any qualified platform.
4. When delivery cannot happen (container worker stopped, recipient closed,
   runaway loop), the **sending agent** is told why and what to do, instead of
   the message quietly waiting for a person. A stopped *local* worker is
   started automatically.

The existing safety properties stay: cross-project and external mail never
injects; explicit mute and an explicit per-tab **Off** still win; one
delegation still wakes the coordinator once; queues and budgets stay bounded.

## What happens today

Evidence from this install (run of 2026-10-15 00:31, one conversation, 12
workers): the three workers that finished each sent one report, and all three
were injected into the coordinator automatically. The basic
launch → report → wake path works. The failures are in everything after
that first round trip, and in the edges around it.

Ranked by how likely they are to be what the user is seeing:

| # | Gap | Where | Effect |
| --- | --- | --- | --- |
| 1 | **Pair loop budget never resets.** `latestMailboxPairDepth` counts every coordinator-exchange message between one conversation and one worker tab, either direction, for the whole retention window (14 days). The 9th message is `inject-held` / `loop-budget-exhausted`. A new delegation does not reset it; only Resume does, one message at a time. | `storage-agent-mail.ts:179-205`, `:1131-1141`, `:1185-1189`; `AgentMailBanner.tsx:51-54` | After about four back-and-forths, every further message needs the user to click Resume. |
| 2 | **Any non-`inherit` override kills the coordinator exception.** `coordinatorExchange` requires `injectOverride === "inherit"`. With `idle`, replies have `injectDepth > 0` (the sender was injected recently) and are stored. Neither promotion nor Retry handles `injectDepth ≠ 0`. The banner's **Deliver now** silently sets the tab to `idle`, so one click permanently degrades that tab. | `storage-agent-mail.ts:1108-1130`, `:1182`, `:1374`, `:1504`; `agent-mail-service.ts:30-43`; `AgentMailBanner.tsx:112` | Mail lands as `stored`; nobody is woken. |
| 3 | **Coordinator cannot follow up with a busy worker.** A second `send_message` to a worker tab with an open delegation throws "already has an outstanding coordinator delegation". | `commands-registry-coordinator.ts:92-111`, `:335` | The coordinator must wait, poll, or ask the user. |
| 4 | **Addressing is tab-based and under-specified.** The delegation frame names only the coordinator *environment*; `send_message` needs `toTabId`, so the worker must call `list_mailboxes` first. `send_prompt_to_tab` gives the worker no coordinator address at all, but still opens a delegation. The coordinator has to know the worker's tab id. | `review-evidence-frames.ts:278-293`; `control-mcp-server.ts:349-354`, `:1017-1026` | Wasted turns, wrong-recipient sends, or a report that never arrives (the coordinator then gets the "finished without a report" notice). |
| 5 | **Transient dispatch errors become `inject_failed`.** "Project checkout is changing", bridge start/auth failure, rebuild fence and shutdown are thrown as plain errors and marked rejected, which needs a manual Retry. | `native-agent-service-prompt.ts:694-697`; `native-agent-service-base.ts:580-585`; `native-agent-service-provider.ts:631-634`, `:849-873` | Red banner, user clicks Retry. |
| 6 | **Delegations that never close hold the worker's report forever.** The periodic sweep reads raw activity (`sessionActivitySnapshot`), not the turn view, so a worker whose turn ended but whose background tasks still run stays `working`; if the turn-end edge was missed (restart, settle error) nothing closes it. A report held after the wake was already prepared as `notice` keeps a delegation id that is never released, and the UI offers no action for it. | `index.ts:340`, `:431-442`; `coordinator-service.ts:538-573`, `:593-670`; `storage-agent-mail.ts:1449-1452` | Report stored, coordinator never woken. |
| 7 | **Stopped / unready recipients wait silently.** Mail to a stopped worker or a paused/errored coordinator stays `pending-inject` with `environment_stopped` / `environment_unready`. The sender's `send_message` result says `pending-inject`, which reads as success. | `agent-mail-service.ts:319-337` | Coordinator thinks it delegated; nothing runs. |
| 8 | **Coordinator tool gates refuse mail tools on two platforms.** Pi's `COORDINATOR_MAIL_TOOLS` uses Agent Tools names (`check_inbox`, `read_message`, `reply_message`) but a coordinator holds Control MCP, whose names are `read_messages` and `get_message`; those, plus every other control tool, are blocked by the read-only gate. OpenCode's coordinator permission set is `*: deny` plus a read-only list with no `orkestrator_*` allow. | `pi-bridge/src/mcp.ts:57-66`, `:137-141`; `pi-bridge/src/interactions.ts:59-79`; `opencode-provider-helpers.ts:209-217`, `:306-322` | Pi/OpenCode coordinators cannot read or answer their mail by tool. (Claude, Codex, Cursor already allow `orkestrator` tools in coordinator mode.) |
| 9 | **Worker approval overrides.** Default worker policy is `auto-approve`, so mail tools never prompt. A worker switched to `ask` prompts for mail tools on Codex, OpenCode, Pi, Grok; switched to `deny` it refuses them on Claude and Codex. A worker waiting on any approval also keeps its delegation open. | `native-agent-execution-policy.ts:32-59`; per-bridge gates | Prompts or silent refusals on Orkestrator's own tools. |
| 10 | **No diagnostics.** The backend logs nothing when a message is stored instead of injected, or held, or skipped by the drain. | `storage-agent-mail.ts`, `agent-mail-service.ts` | "It isn't working" cannot be diagnosed after the fact. |

| 11 | **Peer mail does not wake.** Mail between ordinary (non-coordinator) tabs follows `defaultInjectPolicy`, which defaults to `off`, so it is stored. Even with `idle`, any reply from a tab that was itself injected has `injectDepth > 0` and is stored, so peers can never hold a back-and-forth. | `storage-agent-mail.ts:1108-1120`, `:1176-1183` | Peers must be prompted by the user to read their inbox. |

## Design

### Family membership is explicit, not inferred from trust

Today "coordinator exchange" means *same-project, recipient override is
`inherit`, and one side is a coordinator or system*. That is both too broad
(any same-project tab can wake any coordinator) and too fragile (one override
click turns it off).

Introduce one predicate, shared by send-time scheduling and the drain so they
cannot diverge again:

```ts
// packages/protocol/src/agent-mail.ts
export function coordinatorFamilyDelivery(input: {
  trust: AgentMailTrust;
  senderKind: AgentMailSender["kind"];
  recipient: { ownerKind?: "coordinator"; injectOverride: InjectOverride; mutedInbound: boolean };
  family: boolean; // resolved by the backend, see below
}): "inject" | "store" | "bounce";
```

`family` is true when the backend can prove the pair is a coordinator
conversation and a tab in an environment that conversation launched or adopted,
from the existing `CoordinatorWorkflowAssociation` rows (kind `environment`,
matching `coordinatorId` + `conversationId`), *not* only from open delegations.
System mail for that conversation (wake notices) also counts.

The predicate classifies each same-project message into a **route**:

- `family` — a coordinator conversation and a tab in an environment that
  conversation launched or adopted (plus system mail for that conversation).
- `peer` — two tabs, neither in an environment that has a coordinator
  association. This includes sibling tabs in the same ordinary environment.
- `isolated` — anything else involving a coordinator-created environment:
  sibling family workers, a family worker and a peer, a worker and a coordinator
  that did not create it.

Rules for `family` and `peer`:

- Inject when the recipient is idle. `inherit` and `idle` both mean "on". Only
  an explicit `off` stores, and only mute bounces.
- `injectDepth` is not a gate. The thread hop rule is replaced by the budget
  below.

`isolated` mail gets no route exception: it follows the recipient's inject
policy like user mail, so under the default Off it is stored and readable but
wakes nobody. Its `placementReason` is `isolated-route`, so the sender can see
it should route through its coordinator.

A new setting, **Settings → Messaging → Wake peers** (default on), turns the
`peer` route off for users who want the old pull-only behaviour.
`defaultInjectPolicy` then only governs mail from the user and from senders
outside these routes.

Persist the resolved route on the message (`route`) at send time, so the
drain, promotion and retry read one stored fact instead of re-deriving it.
The mailbox carries `coordinatorOrigin`, the runtime id of the open
conversation that created its environment, derived on every mailbox sync from
the coordinator's launch associations (the ones with a base commit). Workflow
associations are only removed with the project, so no separate field on the
environment record is needed. A delegation that only messages or prompts an
existing environment does not make it a worker, and when the creating
conversation closes the environment's tabs become peers again.

### Addressing by environment

- Coordinator `send_message` accepts `environmentId` with `tabId` optional.
  Resolution order: the open delegation's `workerTabId`; else the tab the
  association recorded at launch (`startup-agent` for `launch_environment`, the
  job tab for `launch_job`); else the only pull-capable tab; else
  `ambiguous-recipient` with the candidate list.
- Agent Tools `send_message` from a family worker accepts
  `toEnvironmentId: "coordinator:…"` with no tab id. A coordinator runtime
  environment has exactly one mailbox, so this is unambiguous. Also accept a
  literal `to: "coordinator"` shorthand that resolves to the worker's own
  family coordinator.
- The delegation frame and `workerAsyncContract` print the exact call
  (`send_message({ to: "coordinator", body })`), and `send_prompt_to_tab` gets
  the same frame, because it opens a delegation too.

### Budget that resets on real progress

Replace the 14-day pair depth with a budget that resets on real progress:

- **Family:** each delegation opens with a fresh budget of 16 wakes across both
  directions.
- **Peer:** 16 consecutive autonomous wakes per pair. There is no delegation, so
  only a user prompt resets it.
- A user prompt to either side resets the pair's budget on both routes (a human
  just took part).
- A rate ceiling stays as the runaway guard: at most 40 wakes per pair per
  rolling hour, plus the existing global pending-inject cap.
- When a family budget trips, mail is still stored and the **coordinator**
  receives one system notice ("worker X loop budget exhausted; send a new
  delegation or ask the user"), so the agent can decide. When a peer budget
  trips, the sender's `send_message` result says `budget-held` and the banner
  shows it. Resume in the UI releases *every* held message for that pair in one
  action.
- Both numbers are settings under Settings → Messaging.

### Follow-ups to a busy worker

Allow coordinator `send_message` while a delegation is open. The message is
stored `pending-inject` on the worker and delivered at the worker's next idle
edge, after the current delegation completes and wakes the coordinator. That
injection opens the next delegation. Keep "one delegation = one wake": the
follow-up is a new delegation, not an extension of the open one.

### Make the sender's result honest

`send_message` (both MCP surfaces) returns a `delivery` field computed from the
same predicate plus recipient state:

| `delivery` | Meaning | Agent guidance in result |
| --- | --- | --- |
| `will-inject` | Family or peer mail, recipient running; delivered at next idle | "Finish your turn." |
| `starting-recipient` | Family mail to a stopped **local** worker; the backend is starting it | "Delivered once it is running. Finish your turn." |
| `queued-behind-delegation` | Follow-up to a busy worker | "Delivered after the worker's current turn." |
| `recipient-stopped` | Family mail to a stopped **container** worker | "The worker is stopped. Call `start_environment` to deliver, or ask the user." The message stays queued and is delivered if the environment starts. |
| `stored-only` | `isolated` route, explicit Off, or Wake peers turned off | "Recipient must pull; nobody will be woken." For `isolated` family mail, adds "route this through your coordinator". |
| `budget-held` | Budget exhausted | Family: "Start a new delegation or ask the user." Peer: "Ask the user to resume." |

### Stopped workers

When family mail reaches a stopped worker, the backend acts once, at send time:

- **Local worker:** start it through the normal start path (no setup re-run,
  same worktree). Mail is delivered by the drain once the session is idle. A
  start failure returns `recipient-stopped` with the reason, and the
  coordinator receives one system notice.
- **Container worker:** do not start it. Return `recipient-stopped` and, when
  the sender is a worker or system, also notify the coordinator, so the
  coordinator always knows about a stopped container in its family.

Peer mail to a stopped environment does not start it; it waits and the sender
gets `recipient-stopped`.

### Transient failures retry instead of failing

Classify dispatch errors at `native-agent-service-prompt.ts` into
`not-processed` (checkout lease, rebuild fence, shutdown, bridge start/auth
before the turn was sent) and `ambiguous`. `not-processed` goes back to
`pending-inject` with the existing 2 s → 30 s backoff and a `placementReason`;
the drain also checks the checkout lease up front. After the backoff cap, keep
retrying at the cap interval for family mail rather than settling as failed.
Only `ambiguous` stays `inject_failed` (the existing double-send rule).

### Close delegations from the same signal the drain uses

- The sweep reads the turn view (`readyForInput`), not raw activity, so a turn
  that ended with background tasks still running closes its delegation.
- On backend start, reconcile every open delegation against the worker's
  current turn view once, so a missed edge cannot hold a report forever.
- Fix the `notice` race: mail that arrives after a `notice` wake was prepared
  is released as its own family message (new carrier), not left with a dead
  delegation id. `retryAgentMailInject` and the banner treat
  `delegation-running` holds whose delegation is closed as releasable.

## Steps

Each step is independently shippable and testable. Order is by user impact.

1. **Diagnostics (gap 10). Done.** `[agent-mail] placed` per send,
   `[agent-mail] waiting` when the drain's skip reason for a message changes,
   `[agent-mail] dispatched` per batch; ids, route, placement and reason only.
   Stored mail records why in `placementReason` (`inject-policy-off`,
   `isolated-route`, `reply-to-injected-turn`, `recipient-cannot-inject`,
   `untrusted-sender`, `hop-limit`), which `get_message_status` already
   returns, so no separate `why` field was added.
2. **Route predicate + persisted route (gaps 2, 11). Done.**
   `classifyAgentMailRoute` / `agentMailRouteWakes` in the protocol, routes
   `coordinator` / `peer` / `isolated`, used by `sendAgentMail`, the drain,
   promotion and retry. `inherit`/`idle` both on; explicit `off` stores and
   switching it back on promotes the routed mail it held. **Wake peers**
   setting (default on). **Deliver now** and Retry stamp `userReleasedAt`,
   which the drain honours once, and the banner no longer rewrites the policy.
   No upgrade migration: mail stored before routes existed keeps its old rule,
   so an upgrade cannot suddenly wake agents with stale mail.
3. **Budget (gap 1). Done.** Routed pairs share one budget (default 16)
   instead of the 14-day pair depth. A coordinator message to its worker is
   depth 0, a new request. A prompt to either tab (renderer, CLI, queued, or a
   coordinator's `send_prompt_to_tab`) moves the tab's `budgetResetSequence`
   past earlier mail, and Resume releases every held message in the tab at
   once. Hourly limit (default 40 per pair) holds with `hourly-limit` and
   releases itself as the window moves. A worker's held mail sends its
   coordinator one notice per budget or hour. Both numbers are settings.
4. **Environment addressing + frames (gap 4).** Optional tab id on both
   surfaces, `to: "coordinator"` shorthand, exact call in the delegation frame,
   frame on `send_prompt_to_tab`.
5. **Follow-ups while busy, stopped workers, honest `delivery` result
   (gaps 3, 7).** Auto-start local family workers; `recipient-stopped` plus a
   coordinator notice for containers.
6. **Transient-failure retry and delegation close fixes (gaps 5, 6).**
7. **Coordinator tool gates (gap 8).** Pi: build the allowlist from the
   Control MCP tool names the coordinator credential actually exposes, not a
   hard-coded Agent Tools list. OpenCode: add an `orkestrator_*` allow rule to
   the coordinator permission set. Add a conformance test that, for every
   qualified coordinator platform, the full Control MCP mail set
   (`list_mailboxes`, `send_message`, `read_messages`, `get_message`,
   `get_message_status`, `ack_message`) is allowed without a prompt.
8. **Worker policy overrides (gap 9).** Treat `orkestrator` mail tools as
   always-allowed on workers regardless of the environment's approval policy
   (they write only to the backend's own store, rate-limited per tab). Claude
   `deny`/`dontAsk` and Codex `deny` add the `orkestrator` allow; Codex `ask`,
   OpenCode `ask`, Pi `ask`, Grok `ask` auto-approve that server's tools.
9. **Docs.** Update `agent-messaging.md` (routes, Wake peers setting, budget,
   `delivery` field, capability table) and `coordinator.md` (addressing, follow-ups).

## Tests

- `storage-agent-mail.test.ts`: family and peer mail inject with
  `defaultInjectPolicy: "off"`, with override `idle`, and with
  `injectDepth > 0`; explicit `off` stores; mute bounces; sibling family
  workers, family worker ↔ peer, and worker ↔ foreign coordinator are stored
  with `stored-only`; Wake peers off stores peer mail; cross-project never
  injects.
- Budget: 20 alternating messages inside one delegation trip at 16; a new
  delegation and a user prompt each reset it; a family trip produces exactly one
  coordinator notice; peer budget resets only on a user prompt; 41 wakes in an
  hour trip the ceiling; bulk Resume releases all.
- Stopped workers: family mail to a stopped local worker starts it once and is
  delivered; to a stopped container returns `recipient-stopped` and notifies the
  coordinator once; peer mail never starts an environment.
- Addressing: coordinator send by environment id resolves to the delegated tab;
  ambiguous environment returns candidates; worker `to: "coordinator"` resolves
  only for a family worker and is `policy-denied` otherwise.
- `coordinator-service.test.ts`: follow-up while busy is delivered after the
  wake and opens a new delegation; sweep closes on `readyForInput`; restart
  reconcile closes a delegation whose edge was missed; `notice` race releases.
- `agent-mail-service.test.ts`: `not-processed` errors back off and retry;
  ambiguous stays `inject_failed`.
- Bridge tests: Pi and OpenCode coordinator gates allow the Control MCP mail
  set; worker `ask`/`deny` overrides allow `orkestrator` tools on every bridge.
- One end-to-end scenario in `coordinator-conformance.test.ts`, defaults
  untouched (`defaultInjectPolicy: "off"`): launch two workers → both report →
  coordinator follows up with one by environment id → worker replies → ten more
  alternating messages → zero user actions, zero `stored`/`inject_failed`
  placements in the family. A second scenario with two ordinary environments
  exchanging ten alternating messages, also with zero user actions.
- Real stack: the same scenario once per qualified platform, as part of the
  coordinator live suite in `docs/todo/coordinator-to-implement.md`.

## Decisions (confirmed 2026-10-15)

1. **Routes.** Workers created by a coordinator mail that coordinator with a
   wake. Workers not created by a coordinator mail each other with a wake.
   Mail between sibling coordinator-created workers, or between a
   coordinator-created worker and anyone other than its coordinator, is stored
   without a wake (interpretation of the decision; the coordinator stays the
   hub for its workers).
2. **Stopped workers.** Family mail starts a stopped local worker. A stopped
   container worker is not started; the coordinator is told.
3. **Budget.** 16 wakes per delegation (family) or per pair without user input
   (peer); rate ceiling 40 wakes per pair per hour. Both are settings.
4. **Mid-turn worker mail stays held until the worker's turn ends.** A worker
   that needs an answer sends its question and ends its turn, which wakes the
   coordinator immediately.
