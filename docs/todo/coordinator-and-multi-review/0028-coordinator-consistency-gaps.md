# Coordinator consistency gaps

Checked against `main` at `2459b05c` (2026-10-15).

Every enabled platform can already inspect, delegate, wake and queue through
the same coordinator interface. This file collects the smaller differences
that keep the platforms from feeling the same, and the coordinator product
surfaces that are deliberately kept off the parity path. None of them blocks
mail or delegation work: a platform without steer is still a complete
dispatcher if queue and wake work.

## Current state

- **Steer.** `nativeAgentCapabilities()` in
  `packages/protocol/src/native-agent.ts` gives Claude, Codex, Pi and Cursor
  `actions.steer`. OpenCode's actions are `compact`, `undo`, `redo` and
  `share`, with no steer; Grok's are empty. Coordinator does not opt out of
  steer anywhere. Queueing a prompt during a turn works on all six.
- **Polling.** The coordinator poll guard (`coordinatorPollGuard` in
  `apps/backend/src/core/control-mcp-server.ts`) covers `read_messages` and
  `get_message_status` only. A model can still poll worker status through
  `list_environments`.
- **Waiting workers.** The toolbar chip ("Waiting on N workers",
  `awaitingWorkers` in `apps/web/src/components/projects/CoordinatorPanel.tsx`)
  lists workers with a running delegation. It does not mark a worker whose own
  session is `waiting` on an approval or question as needing a person. The
  data now exists: a running delegation carries `waiting.since` from the
  worker tab's own turn activity (written by status wakes), but that write
  does not announce a coordinator change, so the chip would not refresh.
- **Status wakes.** A coordinator is woken when work it started settles
  (`coordinator-status-wakes.ts`, "Status wakes" in `coordinator.md`). A
  coalescing status notice waits out its 10-second hold even when another
  message to the same coordinator is dispatched meanwhile, so that pair costs
  two wakes instead of one. A waiting notice says "input or an approval":
  activity state does not say which.
- **Mail carriers.** Each carrier's JSON payload carries a `kind` derived from
  its authenticated sender (`agentMailKind`) and, for workflow notices, a
  structured `notice` (resource, state, tone). The transcript renders every
  carrier in a batched prompt as its own collapsible tile (`MailTile`) with
  `data-mail-kind` and `data-mail-tone`.
- **Open conversations.** `MAX_OPEN_COORDINATOR_CONVERSATIONS` is 16, main
  included (`coordinator-service.ts`). A conversation created by
  `createConversation` starts unassigned, and unassigned conversations count
  toward the limit.
- **Model favourites.** The coordinator composer passes the qualified platforms
  as `platformFilter` (`AgentNativeTab.tsx`), which narrows `enabledPlatforms`
  in `AgentNativeTab.helpers.tsx`. Favourites are passed through unfiltered,
  and the favourites view of `AgentModelPicker` lists every favourite, with a
  placeholder row when its model is not in the filtered catalogue.
- **Sidebar activity.** The environment's working/waiting icon still comes
  from the persisted `agentActivityState` aggregate. The agent registry
  (`apps/backend/src/core/agent-registry.ts`) has no event of its own by
  design; consumers re-read it on the events it is derived from.
- **Coordinator MCP surface.** `COORDINATOR_CONTROL_TOOL_NAMES` in
  `packages/protocol/src/coordinator.ts` is the full list. A backend
  `launch_terminal_job` command exists (`commands-registry-terminal.ts`) but is
  not exposed to coordinators. Workers start from a recorded base commit;
  uncommitted root changes are never copied.

## Outstanding work

### Code

1. **Steer adapters for OpenCode and Grok.** Both are blocked and tracked in
   [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md).
   OpenCode's native steer needs OpenCode 2.x (`delivery: steer` on its
   prompt API, see [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md)); Grok
   needs an ACP equivalent of mid-turn input. Neither gets a coordinator-only
   workaround.
2. **Poll guard for `list_environments`.** Extend the same revision-based
   counter and budget to `list_environments`, but only if live runs in
   [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md) show
   coordinators polling it. Live evidence on 2026-10-18: no coordinator called
   `list_environments` in the async or worker-mail family scenarios on Claude,
   Codex, OpenCode or Cursor.
3. **Unused conversations.** When a new conversation is created, auto-close an
   unassigned conversation whose draft is empty, so the 16-conversation limit
   cannot be filled with unused composers.
4. **Favourites under `platformFilter`.** Hide, rather than show, favourites
   for platforms the current conversation cannot use.
5. **Waiting marker on the chip.** Mark delegated workers whose
   `delegation.waiting` is set as needing a person in the "Waiting on N
   workers" chip. Needs the status-wake bookkeeping to announce a
   `coordinator` change when an episode starts or ends.
6. **Coalesced notices ride along.** When the drain dispatches mail to a
   coordinator, let status notices still inside their coalescing hold join that
   batch rather than wake it again ten seconds later.
7. **Find inside collapsed mail tiles.** Transcript find counts matches in a
   collapsed tile's whole body but only the first three lines are visible;
   expand the tile when the current match is in the clipped part.
8. **Approval or question.** Say in a waiting notice whether the worker is
   blocked on an approval or a question, from the pending interaction rather
   than the activity state.

### Product surfaces kept off the parity path

These are missing coordinator capabilities, not platform adapters. Each needs
its own authority and idempotency design before it is exposed.

- Copying uncommitted root changes into a worker (a user-selected patch).
- Coordinator MCP for terminal or tmux launch (building on
  `launch_terminal_job`), browser launch and navigation, arbitrary pane
  editing, custom-fix model switches, reviewer subtabs, looped review and
  feature-plan launch.

## Constraints and rationale

- No delegation-age timer ("still running after N hours"). The toolbar chip
  already shows the wait, and an unsolicited timer is exactly the kind of
  update the async contract removes. Status wakes keep to this: each one is an
  observed state change, and the 20-second waiting debounce only suppresses
  waits too short to matter; it never reports elapsed time.
- If a "waiting worker" marker is added, it must come from the worker tab's
  own session phase, never from the environment-wide aggregate. The
  architecture refuses to infer tab-level attention from environment status.
- Repository checkout mutation stays UI-only; it is not a coordinator tool.
- Do not block mail or delegation work on steer.
- The agent registry stays event-less. A push event was considered and
  decided against; consumers re-read on the source events.

## Open questions

- Should the sidebar working/waiting icon move from the persisted
  `agentActivityState` aggregate onto the agent registry (see "Who reads it"
  in `agent-registry.md`)?

## Needs verification

- How the favourites view renders a favourite whose platform is filtered out
  (a selectable placeholder or a disabled row). The data path above shows it is
  listed; the exact rendering decides how small item 5 is.

## Related

- [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md) and
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md) and
  [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md) for steer.
- [`coordinator.md`](../../architecture/coordinator.md) ("One main coordinator,
  and side agents", "Exposed-action audit"),
  [`agent-registry.md`](../../architecture/agent-registry.md),
  [`control-mcp.md`](../../architecture/control-mcp.md).

## Replaces

- `docs/todo/coordinator-to-implement.md` (the steer row of "Current matrix",
  §3 "Turn-control adapters", §4 "Smaller consistency gaps" and §5 "Product
  surfaces that are not provider work")
- `docs/plans/coordinator-worker-mail.md` (the agent registry "Not yet" line:
  the push event, now decided against, and moving the sidebar icon onto the
  registry)
