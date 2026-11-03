# Close, select and pause are outside the per-project serializer

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Serialize them**: `closeConversation`, `selectConversation` and `setPaused` run in `serialize` like create and ensure. Status: open.

### 1. Serialize them

**Problem.** A close can land between `ensureMainConversation` returning and the wake being sent, so the report goes to a tombstoned mailbox and the delegation is marked woken.

**Context.** `serialize` covers create, ensure and assign (`coordinator-service.ts:430`, `:461`, `:578`, `:655`). It does not cover the wake pass: `deliverDelegationWakesOnce` holds only the ensure step (`:1198`), then uses the returned conversation for the release or send (`:1219`, `:1288`).

**Investigation.** `closeConversation` (`:739-765`), `selectConversation` (`:713-737`) and `setPaused` (`:767-797`) call `mutateCoordinatorWorkspace` directly. Each store mutation is safe by itself (`enqueueCoordinatorMutation`), so the risk is the gap between steps, not a torn write. So serializing close does not by itself close the gap, unless the wake's send also runs inside `serialize`.

**Decisions.**

- **Is wrapping the three enough?**
  - **Wrap them, and re-check the conversation is open just before `markCoordinatorDelegationWoken`, leaving it unwoken if it closed (recommended).**
    - Pros: the delegation is retried and adopted by the next main, with no lock held across a mail send.
    - Cons: the mail already sent to the closed box needs `moveClosedCoordinatorMail` to carry it, which it does for owed reports.
  - **Run each wake's send inside `serialize` as well.**
    - Pros: closes the gap outright.
    - Cons: a slow send blocks the user's close and select on that project.

## Needs verification

Reported in the report and confirmed by reading only; the race was not reproduced.

## Related

- [Coordinator report, 4.2 (B6)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability) and [6, partial serialization](../2026-10-27-coordinator.md#6-maintainability)
- [0300-waiting-episode-cleared-only-on-working.md](0300-waiting-episode-cleared-only-on-working.md): the other half of B6
