# One conversation's startup failure takes down the whole coordinator

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Record the startup error on the conversation**: a bridge failure marks the conversation that failed, and the workspace stays `ready` unless the failure really is workspace-wide. Status: open.
2. **Show it in that conversation's pane**: name the conversation, with Retry, Close conversation and Copy error. Status: open (depends on 1).

### 1. Record the startup error on the conversation

**Problem.** When any one conversation's bridge fails to start, the workspace goes to `lifecycleState: "error"`. That state is read as "the coordinator is down" everywhere, so a failed side agent stops the main and its workers' mail.

**Context.** `CoordinatorConversation` (`packages/protocol/src/coordinator.ts:98`) has no error field. `lastStartupError` lives on the workspace (`:685`).

**Investigation.** `commands-servers.ts:1439-1440` sets `lifecycleState: "error"` on the workspace while clearing only the failing conversation's bridge fields. The readers treat anything but `ready` as unavailable: Control MCP refuses every conversation's credential with 409 (`control-mcp-server.ts:571`), mail is skipped as `environment_unready` (`agent-mail-service.ts:768`) and runtime resolution returns `workspace-not-ready` (`coordinator-runtime.ts:50`). A later successful start of any conversation writes `ready` and clears the error (`commands-servers.ts:1400-1401`), so the state can flip between conversations. Recovery is `ensure`, which resets the workspace to `ready` (`coordinator-service.ts:469-480`).

**Decisions.**

- **Where does the error live?**
  - **A `startupError` on the conversation, gating only that conversation's runtime (recommended).**
    - Pros: a failed side agent leaves the main and the wake path working; matches the one-bridge-per-conversation design.
    - Cons: every reader of `lifecycleState` above needs a conversation-level check; older clients still read the workspace field during a mixed-version window.
  - **Keep the workspace state, change only the message.**
    - Pros: small.
    - Cons: the outage stays; only the wording improves.

### 2. Show it in that conversation's pane

**Problem.** The banner does not say which conversation failed, and offers Retry only.

**Context.** Since `e5245dfd6` (#1644) the failure is a banner rather than a card replacing every pane, so the report's point about the transcript being replaced no longer holds as written. See [Current state](#current-state).

**Investigation.** `CoordinatorPanel.tsx:1007-1022` renders one workspace-level `CoordinatorBanner` above the panes. Its Retry calls `load()` (`:1011`) with no busy state. `connectionEnabled` (`:799-801`) is false for every conversation while the workspace is not `ready`.

**Decisions.**

- **Where does the notice render?**
  - **Reuse `CoordinatorBanner` inside `renderConversation`, next to the existing provider banner at `:759-776` (recommended).**
    - Pros: same component and placement as the other per-conversation state; split panes show the right notice on the right pane.
    - Cons: a workspace-wide failure, if one is kept, still needs the toolbar-level banner too.
  - **Keep one banner and name the conversation in it.**
    - Pros: no layout change.
    - Cons: Close and Retry then act on a conversation that may not be in front.

## Current state

- `e5245dfd6` (#1644) made startup failure a banner, so the panes stay mounted. Their connections are still disabled (`CoordinatorPanel.tsx:799-801`); see [0200](0200-paused-and-errored-conversations-do-not-connect.md).

## Related

- [Coordinator report, 4.4 (U3)](../2026-10-27-coordinator.md#44-ui-and-ux) and [5.4](../2026-10-27-coordinator.md#54-errors-that-name-what-failed-and-offer-the-next-step)
