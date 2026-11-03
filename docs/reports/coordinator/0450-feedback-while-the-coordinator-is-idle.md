# Feedback while the coordinator is idle but work runs

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Say what the next wake waits for**: a live line under the last message. Status: open.
2. **Notify when a coordinator wakes with a report**: an optional desktop notification. Status: open.

### 1. Say what the next wake waits for

**Problem.** An idle chat with workers running can still look stuck if the user is looking at the conversation rather than at the rail.

**Context.** The Work panel closed most of this gap (see [Current state](#current-state)).

**Investigation.** `data-open-delegations` and `counts` are available in `useCoordinatorWorkItems`; nothing is rendered in the conversation. On narrow screens the panel is only a strip.

**Decisions.**

- **Is the line still worth building?**
  - **Only on narrow screens, or not at all, after using the panel for a while (recommended).**
    - Pros: avoids restating what the rail already says, at the cost of no agent turns either way.
    - Cons: the wide-screen conversation stays quiet.
  - **Always show "Next wake when api-fix finishes".**
    - Pros: as the report proposes.
    - Cons: a second live list; more than one running worker makes it long.

### 2. Notify when a coordinator wakes with a report

**Problem.** A user who leaves the page has no prompt to come back.

**Context.** The report says desktop notifications already exist for human prompts. They do not: the only ones in the code are for a dialog needing attention (`apps/desktop/electron/dialog-attention.ts:18`) and a remote restart (`apps/desktop/electron/main.ts:829`), and `apps/web/src` creates none. The app does have notification sounds (`useNotificationSoundService.ts`).

**Investigation.** A mail wake passes through `dispatchMailInject` (`docs/architecture/coordinator.md:945-948`). A notification would be new for this surface, and would need a web answer too.

**Decisions.**

- **Sound or notification?**
  - **Extend the existing sound service first (recommended).**
    - Pros: exists on every client, with its own settings.
    - Cons: no text, and it needs the app running with sound on.
  - **Build a desktop notification.**
    - Pros: says which worker reported.
    - Cons: new permission handling, and nothing on the web client; a wider feature than this finding.

## Current state

- `eb6bf887a` (#1698): the Work panel shows running work and moves while the coordinator is idle, at no agent cost.

## Related

- [Coordinator report, 5.5](../2026-10-27-coordinator.md#55-feedback-while-the-coordinator-is-idle-but-work-is-running)
