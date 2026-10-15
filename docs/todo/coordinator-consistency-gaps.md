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
  session is `waiting` on an approval or question as needing a person.
- **Mail carriers.** Injected mail has no `data-mail-kind` (or any other kind
  marker) in `apps/web/src`, so system notices and tab replies cannot be
  styled apart.
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
   [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md).
   OpenCode's native steer needs OpenCode 2.x (`delivery: steer` on its
   prompt API, see [opencode-v2.md](opencode-v2.md)); Grok
   needs an ACP equivalent of mid-turn input. Neither gets a coordinator-only
   workaround.
2. **Poll guard for `list_environments`.** Extend the same revision-based
   counter and budget to `list_environments`, but only if live runs in
   [coordinator-live-conformance.md](coordinator-live-conformance.md) show
   coordinators polling it.
3. **Mail carrier kind.** Optionally add `data-mail-kind` to injected mail
   carriers so `system` notices and `tab` replies can be styled apart. No new
   message type.
4. **Unused conversations.** When a new conversation is created, auto-close an
   unassigned conversation whose draft is empty, so the 16-conversation limit
   cannot be filled with unused composers.
5. **Favourites under `platformFilter`.** Hide, rather than show, favourites
   for platforms the current conversation cannot use.

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
  update the async contract removes.
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

- [coordinator-read-only-adapters.md](coordinator-read-only-adapters.md) and
  [coordinator-live-conformance.md](coordinator-live-conformance.md).
- [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md) and
  [opencode-v2.md](opencode-v2.md) for steer.
- [`coordinator.md`](../architecture/coordinator.md) ("One main coordinator,
  and side agents", "Exposed-action audit"),
  [`agent-registry.md`](../architecture/agent-registry.md),
  [`control-mcp.md`](../architecture/control-mcp.md).

## Replaces

- `docs/todo/coordinator-to-implement.md` (the steer row of "Current matrix",
  §3 "Turn-control adapters", §4 "Smaller consistency gaps" and §5 "Product
  surfaces that are not provider work")
- `docs/plans/coordinator-worker-mail.md` (the agent registry "Not yet" line:
  the push event, now decided against, and moving the sidebar icon onto the
  registry)
