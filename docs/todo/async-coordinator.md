# Asynchronous coordinator — design and implementation plan

Status: implemented, 2026-09-08. Branch `async-coordinator-a8316555eff1-r1`.

Phases 0–3 landed together. Where the implementation departed from the plan it
is noted inline below; the one substantive change is that releasing held mail
required batching in the mail drain (see Phase 2), because releasing N messages
individually would have produced N turns — the drip this design removes.

## Goal

A coordinator conversation should behave like a dispatcher, not a supervisor
that sits on the line. After it launches or messages a worker, its turn ends
and the composer is free. The user can keep sending prompts. When a worker
reports back, the coordinator is woken by that message as a fresh turn, on
every platform that can delegate (Claude, Codex, OpenCode).

Non-goals: changing the read-only boundary, changing which platforms may
delegate (Pi, Cursor and Grok remain inspection-only), or migrating any
bridge to a different provider protocol.

## Where things stand

The backend is already asynchronous; the model is not. The facts that shape
this plan, from the code on this branch:

| Fact | Location |
| --- | --- |
| `launch_environment`, `launch_job`, `send_message` and the workflow starts return as soon as the resource is reserved and started. Nothing awaits the worker. | `apps/backend/src/core/control-mcp-server.ts:943-1084`, `commands-registry-coordinator.ts:340-411` |
| The coordinator context prompt tells the model how to delegate but says nothing about what to do afterwards. The tool results say `accepted` and stop. | `native-agent-service-base.ts:458-478` |
| The mail tools `read_messages`, `get_message`, `get_message_status` are unrestricted reads, so a model that decides to "wait" can loop on them. Codex's read-only sandbox also permits `sleep`. Claude's read-only shell allowlist does not include `sleep`. | `control-mcp-server.ts:1512-1625`, `bridges/claude-bridge/src/services/read-only-policy.ts:50` |
| A prompt sent while a turn is running is queued, not refused, on every platform (`capabilities.queue` is true for all six). The composer shows "Add to queue". Queued prompts drain when the provider reports idle. | `packages/protocol/src/native-agent.ts:470`, `apps/web/src/components/native-agent/AgentNativeTab.controller.tsx:696-714`, `native-agent-service-reconciliation.ts:774-1010` |
| Mail wake exists. Every ~2 s the sweep drains pending injects into native sessions whose presence is `idle` or `unknown`; coordinator exchanges bypass the idle-policy and thread-depth gates. | `agent-mail-service.ts:222-359`, `apps/backend/src/core/index.ts:655-660`, `storage-agent-mail.ts:1090-1123` |
| Mail injection is held with reason `queue` when the user's prompt queue is non-empty, so user prompts always run before worker mail. | `native-agent-service-prompt.ts:216-232` |
| The Git turn lock is released when dispatch returns, not when the turn ends. | `native-agent-service-prompt.ts:288-290, 462` |
| Worker completion is not signalled by the backend. Only `build-pipeline` and `multi-review` associations produce a system notice; `environment` associations are skipped. A worker that forgets to reply leaves the coordinator idle forever. | `coordinator-service.ts:395-470` |

### The presence gap

Coordinator sessions are invisible to the activity reconciler. The scan groups
sessions by `loadEnvironments()` and drops any session whose id is not an
environment (`native-agent-service-reconciliation.ts:152-160`). A coordinator
runtime id (`coordinator:<id>:<conversation>`) never is. Consequences:

1. Dispatch sets the session to `working` (`native-agent-service-prompt.ts:410`).
   The next sweep deletes that entry because the key is not "live"
   (`reconciliation.ts:357-365`). From then on the coordinator's observed
   activity is `unknown`; it never reads `idle`.
2. `mailInjectPresence` therefore answers `unknown`, which the drain treats as a
   "cold tab" and lets through to `dispatchMailInject`. The `prepare` fence
   then does a real `readProviderStatus`; if the turn is still running the
   message is held `busy` with exponential backoff up to 30 s
   (`storage-agent-mail.ts:1600-1612`).
3. A held message is retried only when the backoff expires; the early-retry
   path (`if (deferredUntil) { if (nativePresence !== "idle") continue; ... }`)
   never fires for a coordinator because presence is never `idle`.
4. `onActivityTransition` never fires for coordinators, so nothing can react
   to a coordinator turn ending.

Net effect: a worker reply reaches an idle coordinator, but only after the
2 s sweep plus whatever backoff the last `busy` hold left behind, and only via
a provider status probe per attempt. It works by accident of the `unknown`
fallback, not by design. This is the first thing to fix, because every later
phase depends on "coordinator went idle" being a real event.

## Design decisions

1. **Fire and finish.** The coordinator's turn contract becomes: inspect,
   delegate, summarise what was delegated and what will happen next, end the
   turn. Waiting is never done inside a turn. This is stated in the context
   prompt, in every delegation tool result, and in the MCP server
   instructions, so it holds regardless of which platform's model is driving.
2. **Wake is backend-owned and event-driven.** Presence for a coordinator
   session comes from the same reconciler as an environment session, so idle
   is an observed edge. That edge triggers the mail drain and the prompt-queue
   drain immediately rather than waiting for the next sweep.
3. **One request, one wake, at the end.** The coordinator is woken exactly
   once per delegation request (a launch, a job, or a coordinator mail to a
   worker), and only when the worker turn that request started has finished.
   Nothing the worker does mid-turn wakes the coordinator: progress mail is
   stored and held, approvals and questions the worker raises are shown in
   the UI, and the "finished" edge is what releases everything at once. The
   backend enforces this; the worker prompt merely explains it.
4. **Polling is discouraged by contract and bounded by the server.** Within
   one coordinator credential, repeated unchanged reads of the mailbox return
   a structured "no new mail; end your turn, you will be woken" answer instead
   of the page, after a small budget. This is deterministic and
   provider-neutral, unlike prompt wording.
5. **Queue-first ordering stays.** User prompts queued during a turn run before
   injected worker mail. Steering the coordinator mid-turn is offered only
   where the platform already qualifies for steer (Codex, Pi); it is not
   required for this feature.
6. **One conformance suite defines "async".** A platform is claimed to be
   asynchronous only if the shared test drives a launch, ends the turn,
   delivers a reply, and observes a wake, against that platform's provider.

## Phase 0 — Coordinator presence and idle edges (bug fix)

Goal: make a coordinator session's activity authoritative and let the
backend react to its turn ending. No user-visible behaviour change beyond
faster mail wake.

### Backend

- `native-agent-service-reconciliation.ts`
  - In `reconcileAgentActivityOnce`, build groups from two sources: sessions
    whose `environmentId` is an environment (unchanged), and sessions whose
    id resolves through `resolveCoordinatorRuntime` to `ready`. Reuse the
    synthetic `Environment` that `assertEnvironmentLive` already fabricates
    (`native-agent-service-provider.ts:348-373`) so `isEnvironmentReadyForAgents`
    and `observeProvider` work unchanged.
  - Keep coordinator sessions out of `activityByEnvironment` and out of the
    `environments.json` aggregate write, and skip
    `recordEnvironmentSessionCompletion` for them: there is no environment row
    to update. Extract the environment-only side effects behind an
    `isEnvironmentSession` check inside `recordActivity`.
  - Include coordinator keys in `liveSessionsByKey` so the cleanup loop stops
    deleting their observations.
  - `onActivityTransition` gains `owner` (`environment` | `coordinator`) so
    consumers can filter.
- `apps/backend/src/core/index.ts`
  - In `onActivityTransition`, on a `working → idle | waiting` edge for any
    session, call `this.agentMail.drainInjects()` and, for native sessions,
    `nativeAgents.drainPromptQueue(queueKey)` for that session. Both are
    coalescing already, so the extra calls are cheap.
  - Skip the pull-request probe for coordinator owners.
- `agent-mail-service.ts`
  - No logic change required once presence reports `idle`; the deferred
    early-retry branch starts working for coordinators. Add a
    `coordinator` case to the environment-status pre-check comment so the
    behaviour is documented.

### Tests

- `native-agent-service-reconciliation.test.ts`: a coordinator session whose
  provider reports `running` then `idle` produces `working → idle` in
  `observedSessionActivity` and fires `onActivityTransition` with
  `owner: "coordinator"`; no environment record is written.
- `agent-mail-service.test.ts`: a message held `busy` for a coordinator is
  retried on the next drain once presence is `idle`, without waiting for
  `nextAttemptAt`.
- Integration in `native-agent-service-base.test.ts`: dispatch coordinator
  prompt, provider turn ends, mail arrives, mail is injected on the very next
  drain with no user prompt in between.

## Phase 1 — The turn contract (prompt, tool results, worker preamble)

Goal: the model on every delegating platform ends its turn after delegating,
and knows it will be woken.

### Coordinator context prompt

`native-agent-service-base.ts:458-478`. Add one paragraph after the
delegation line, present only when delegation is available:

> Delegation is asynchronous. After launching a worker, sending it a message,
> or starting a workflow, finish this turn with a short summary of what was
> delegated and what you expect back. Do not wait, sleep, poll the mailbox,
> or repeatedly check message status: worker replies and workflow
> notifications are delivered to you as new messages when you are idle, and
> each one starts a new turn. When a turn begins with such a message, act on
> it and finish again.

The same text is what the conformance suite asserts on, so it lives in one
exported constant (`COORDINATOR_ASYNC_CONTRACT`) in
`packages/protocol/src/coordinator.ts`, not inline.

### Delegation tool results (coordinator scope only)

`control-mcp-server.ts`. Each of `launch_environment`, `launch_job`,
`send_message`, `start_build_pipeline`, `start_multi_review` (whatever the
workflow starts are named in scope) adds to its JSON result:

```json
{
  "delivery": "async",
  "wake": "This conversation will be woken by a mail message when the worker reports or the workflow reaches a terminal phase.",
  "nextStep": "Finish your turn now. Do not poll."
}
```

The MCP server `instructions` string (`control-mcp-server.ts:591-595`) gains a
coordinator-scope sentence with the same contract.

### Worker preamble

Both delegation preambles (`commands-registry-coordinator.ts:385` for
`launch_environment`, `control-mcp-server.ts:1089` for `launch_job`) are
built from one helper in `commands-registry-coordinator.ts` and extended:

> The coordinator is idle while you work and is woken once, when you finish.
> When you reach completion, failure, or a point where you cannot continue
> without an answer, send exactly one report with `reply_message` (to the
> delegation message) or `send_message` to the coordinator mailbox named
> above, then end your turn. Do not send progress updates: any message you
> send before your turn ends is held and delivered together with your final
> report.

The mailbox address (`coordinator:<id>:<conversation>` and the conversation
`tabId`) is included in the preamble so the worker can use `send_message`
when there is no inbound message to reply to. This is the case for a fresh
worker started with an `initialPrompt`: it has no mail to `reply_message` to.

### Polling guard

`control-mcp-server.ts`, coordinator scope. Track per credential
`{ lastMailboxRevision, unchangedReads, windowStartedAt }` on the
`coordinatorCredentials` entry. In `read_messages` (with `unreadOnly` or not)
and `get_message_status`:

- If the mailbox revision (already on the mailbox record) is unchanged since
  the last read and `unchangedReads >= 3` within 120 s, return
  `toolResult({ status: "no-new-mail", instruction: COORDINATOR_ASYNC_CONTRACT })`
  instead of the page, and do not reset the counter.
- Any new revision resets the counter.
- The guard is a read-side contract, not a security boundary; it is bounded
  and cannot lock the model out of reading mail that actually arrived.

The number is deliberately small: a legitimate turn reads its inbox once at
the start and once before finishing.

### Claude specifics

- `sleep`, `watch`, `timeout` stay outside `READ_ONLY_COMMANDS`; add a test
  in `read-only-policy.test.ts` asserting they are refused so nobody adds
  them later as "harmless".
- Claude Code's own long-running tools (`Monitor`, `ScheduleWakeup`,
  `CronCreate`) are not in the coordinator allowlist. Add them to
  `claudeDeniedTools` explicitly and assert it in
  `coordinator-conformance.test.ts` next to `Write`/`Edit`.

### Codex specifics

- The read-only sandbox allows `sleep`. The polling guard is the backstop.
  Additionally, the coordinator permission profile may deny `sleep` by
  argv0; note this as optional hardening in
  `bridges/codex-bridge/src/app-server/` alongside the existing profile, only
  if the conformance run shows Codex reaching for it.

### OpenCode specifics

- The `plan` agent has no sleep primitive; the guard covers mailbox reads.

### Tests

- `control-mcp-server.test.ts`: every delegation tool result in coordinator
  scope carries `delivery: "async"`; the guard trips on the fourth unchanged
  read and clears on a new message.
- `native-agent-service-base.test.ts`: the coordinator context contains the
  contract when delegation is available and omits it otherwise.
- `commands-registry-coordinator.test.ts`: the worker preamble names the
  coordinator mailbox and tab.

## Phase 2 — One wake per delegation, on completion

Goal: the coordinator is woken exactly once per delegation request, when the
worker is finished, whether or not the worker's model remembered to send a
report. It is never woken by progress.

### The delegation record

A delegation is an outstanding request from a coordinator conversation to a
worker tab. It is created by `launch_environment`, `launch_job`, and any
coordinator `send_message` to a worker, and it is closed by one completion.
Persist it on the existing association rather than inventing a new store:

- `packages/protocol/src/coordinator.ts`: `CoordinatorWorkflowAssociation`
  gains `delegation?: CoordinatorDelegation`, holding `requestedAt`,
  `workerTabId`, `state`, `completedAt` and `wokenAt`. *As built:* no
  `workerSessionKey` — the tab id plus the association's `resourceId` is the
  whole address, and the logical session key is derivable from them.
- `launch_environment` and `launch_job` already reserve an `environment`
  association (`commands-registry-coordinator.ts:362-374`); set
  `delegation.state = "running"` there. A coordinator `send_message` to a
  worker tab (`commands-registry-coordinator.ts:255-285`) upserts the
  association for that environment and re-opens it as `running`.

### The completion edge

`apps/backend/src/core/index.ts`, in `onActivityTransition`, for owner
`environment` sessions whose key matches an open delegation's
`workerSessionKey`:

- `working → idle` closes the delegation as `completed`.
- Environment `error`, `stopped`, or deletion closes it as `failed` or
  `stopped`. *As built:* checked on the periodic sweep
  (`reconcileWorkerDelegations`) rather than hooked into each teardown path, so
  a teardown route nobody remembered to hook cannot strand a coordinator.
- `working → waiting` does **not** close it. A worker blocked on an approval
  or asking a question is still running from the coordinator's point of view.
  The state is visible in the coordinator panel (Phase 3) and in the worker's
  own tab; a human answers it, or the worker's model ends its turn with a
  report, which is the completion edge.

Closing a delegation does two things, in order:

1. **Release held worker mail.** Every message from that worker tab to the
   delegating conversation that is sitting in `inject-held` with reason
   `delegation-running` is released onto the pending-inject index. This is the
   wake.

   *As built:* the combining happens in `AgentMailService.drainInjects`, not at
   release. Releasing N messages individually would have delivered them as N
   turns — the first dispatch marks the session working and every sibling is
   held `busy` for a later pass — so the drain now claims every ready message
   for one mailbox, renders their carriers into a single prompt in send order,
   and settles them together. Bounded at 10 messages and 128 KiB of carrier;
   anything over budget is returned to the pending index for the next pass
   rather than dropped. This also fixes the drip for ordinary tab-to-tab mail,
   not just delegations.
2. **Send a completion notice only if nothing was released.** If the worker
   sent no mail at all, a `system` mail is sent with requestId
   `delegation-<associationId>-<completedAt>`, subject
   `Worker <name> finished` / `failed` / `stopped`, and a body naming the
   environment id, tab id, branch and base commit with "The worker did not
   send a report. Inspect the environment through Orkestrator controls."
   This is the fallback wake; it is never sent in addition to the worker's
   own report.

`wokenAt` is stamped after step 1 or 2, so a restart between the edge and the
send retries the notice idempotently and never sends two.

### Holding progress mail

`storage-agent-mail.ts`, in `sendAgentMail` where `shouldScheduleInject` is
computed (`:1090-1123`): when the sender is a worker tab, the recipient is a
coordinator mailbox, and an open delegation exists for that sender tab, the
message is stored with `placement: "pending-inject"` and
`placementReason: "delegation-running"`, and is **excluded** from
`listPendingAgentMailInjects` until the delegation closes. It is readable
through `read_messages` at any time; the coordinator is simply not woken for
it. A worker with no open delegation (unsolicited mail) follows the existing
same-project rules.

The drain (`agent-mail-service.ts:222-359`) needs no new branch: released
messages re-enter the ordinary pending-inject index and go through the same
idle fence, so user prompts queued during the wait still run first.

### Loop control

Each delegation produces at most one wake. A coordinator that reacts to a
report by sending the worker another message opens a new delegation, so the
next wake is again tied to a completion. There is no timer, no per-token
notice, and no repeat on the same edge: the association holds `wokenAt`.

### Tests

- `coordinator-service.test.ts` (or a new `delegation.test.ts`): a
  delegation whose worker goes `working → idle` wakes the conversation once;
  a `working → waiting` reading wakes nothing; a second idle reading wakes
  nothing; environment deletion mid-delegation wakes once as `stopped`.
- `storage-agent-mail.test.ts`: worker mail sent while its delegation is
  running is stored, readable, and absent from the pending-inject index;
  three such messages are released as one carrier on completion; the system
  notice is not sent when a worker report was released, and is sent when
  none was.
- Restart test: an edge recorded with no `wokenAt` sends the notice once on
  the next reconcile.

## Phase 3 — Composer and panel while waiting

Goal: the UI reflects "idle, waiting on workers" honestly and keeps the
composer open.

- `apps/web/src/components/projects/CoordinatorPanel.tsx`: derive
  `awaitingWorkers` from `snapshot.workflows` (associations whose
  `delegation.state === "running"`, or build/review associations without
  `terminalNotifiedAt`). Render a small chip in the toolbar: "Waiting on N
  workers" with links to each environment (the association's `resourceId`).
  A worker whose session is `waiting` (approval or question pending) is
  marked in the chip as needing a human, since it will not wake the
  coordinator on its own.
  This is a projection; it must rehydrate from the snapshot on mount per the
  background-reliability rules in `AGENTS.md`.
- `AgentNativeTab.controller.tsx`: when `isReadOnlyCoordinator` and the turn
  is running, the send button label reads "Send after this turn" instead of
  "Add to queue", so the semantics are visible. No logic change; queueing is
  already the behaviour.
- Injected worker mail already renders as a peer-message carrier. Add a
  `data-mail-kind` on the carrier renderer so coordinator conversations can
  style `system` notices and `tab` replies distinctly (light touch; no new
  message type).
- Optional, Codex and Pi only: expose `/steer` on a running coordinator turn
  through the existing `actions.steer` capability. It is already plumbed; the
  coordinator does not need to opt out, and it lets a user redirect a
  long-running inspection turn without cancelling. Claude, OpenCode and
  Cursor keep queue-only, per `docs/todo/steer/consolidated.md`.

## Phase 4 — Provider matrix and conformance

| Platform | Turn-end signal → `idle` | Wake path | Queue during turn | Polling exposure | Change in this plan |
| --- | --- | --- | --- | --- | --- |
| Claude (`claude-bridge`) | SDK `result` message; `observeActivity` reports idle | `dispatchMailInject` → `dispatchPromptInternal` resume with the carrier as the next user turn | yes | mailbox tools only (`sleep` refused) | Phase 0 presence, Phase 1 contract, deny scheduling tools |
| Codex (`codex-bridge`) | `turn/completed`; bridge status idle | same path → `turn/start` on the thread | yes, plus steer | mailbox tools and `sleep` | Phase 0, Phase 1 contract and guard, optional argv0 deny |
| OpenCode (backend provider) | `session.idle` event; `promptAsync` returns 409 while busy, which the fence maps to `held: busy` | same path → `promptAsync` on the session | yes | mailbox tools only | Phase 0, Phase 1 contract and guard |
| Pi | in-process | none: no MCP client, delegation unavailable | yes, plus steer | n/a | unchanged; prompt already says workers unavailable |
| Cursor | SDK run end | none: no injectable mailbox | yes | n/a | unchanged |
| Grok (`acp-bridge`) | ACP prompt end | none | yes | n/a | unchanged |

### Conformance suite

*As built:* the async behaviour is covered by tests at the layer that owns each
guarantee rather than by one end-to-end scenario replayed per platform —
coordinator presence and the turn-end edge in
`native-agent-service-reconciliation.test.ts`, the one-wake invariant and its
crash recovery in `coordinator-service.test.ts`, single-turn batching in
`agent-mail-service.test.ts`, the tool contract and poll guard in
`control-mcp-server.test.ts`, and the no-waiting-tools boundary in
`coordinator-conformance.test.ts` and the Claude bridge's own policy test.

That is deliberate: every mechanism here is provider-neutral. Presence, the
delegation record, the hold and the batch all live above the provider boundary,
so a per-platform replay would exercise the same code three times through
different stubs. What remains genuinely platform-specific is whether a bridge
reports `idle` at turn end, which the existing per-bridge activity tests already
cover.

The end-to-end scenario below is still worth building against real providers
when the read-only suite next runs; it is not a substitute for the above:

1. Dispatch a coordinator prompt; the fake provider reports `running`.
2. Invoke `launch_environment` through the coordinator credential; assert
   the result carries `delivery: "async"` and returns before any worker
   activity.
3. The fake provider reports `idle`; assert `onActivityTransition` fires with
   `owner: "coordinator"` and that the Git turn lock is released.
4. Enqueue a user prompt while running; assert it is dispatched before any
   pending mail on idle.
5. Send a worker reply as `tab` mail; assert it is injected on the drain that
   follows the idle edge, not after a backoff.
6. Have the worker send two mid-turn messages; assert neither is injected and
   the coordinator stays idle. Flip the worker session `working → idle`;
   assert one carrier containing both is injected and no system notice is
   sent. Repeat with a silent worker; assert exactly one system notice.
7. Call `read_messages` four times with no new mail; assert the guard answer.

## Delivery order and risk

| PR | Scope | Risk |
| --- | --- | --- |
| 1 | Phase 0 | Medium: touches the activity reconciler; guarded by the environment-only side-effect split and new tests |
| 2 | Phase 1 | Low: prompt text, tool result fields, one bounded guard |
| 3 | Phase 2 | Medium: delegation state on associations, a new hold reason in the mail store, one completion edge; the one-wake invariant must be tested including restart |
| 4 | Phase 3 | Low: projection-only UI |
| 5 | Phase 4 | Grows with each PR; the async scenario lands with PR 1 for Codex and is extended per platform |

Documentation: update `docs/coordinator.md` "Worker delegation" to describe
the asynchronous contract, the worker lifecycle notices, and the polling
guard once PRs 1–3 land.

## Decided

- A `waiting` worker (blocked on an approval or a question) does not wake the
  coordinator. It is surfaced in the coordinator panel chip and in the
  worker's own tab for a human to resolve. The coordinator hears from that
  worker only when its turn finishes.
- Worker progress mail never wakes the coordinator. It is held until the
  delegation completes and delivered together with the final report.

## Open questions

- Should the polling guard also cover `list_environments` in coordinator
  scope? A model can poll worker status through it. Proposed: yes, same
  revision-based counter keyed on the environment list revision, same budget.
- Should a delegation have a maximum age after which a still-running worker
  produces a single "still running after N hours" notice? Proposed: no by
  default; the panel chip already shows it, and a timer is exactly the kind
  of unsolicited update this plan removes.
