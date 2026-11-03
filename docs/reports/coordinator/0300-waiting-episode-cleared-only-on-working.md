# A waiting episode is cleared only on a working edge

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Clear `waiting` on any edge that leaves waiting**: including waiting to idle on a delegation that stays open. Status: open.

### 1. Clear `waiting` on any edge that leaves waiting

**Problem.** After waiting → idle on an open delegation, the "needs you" marker stays, and a later wait produces no new notice.

**Context.** A delegation stays open past an idle edge while a follow-up is undelivered or background work holds it. The field's doc comment says it is cleared "when the worker is seen working again" (`packages/protocol/src/coordinator.ts:283-290`), so the comment needs changing too. The Work panel now reads the marker for its Needs you section (`docs/architecture/coordinator.md:1021`), so a stale marker is more visible than when the report was written.

**Investigation.** `noteWorkerActivity` clears only on `event.state === "working"` (`coordinator-status-wakes.ts:1739-1751`). `reconcileWaiting` clears only on `activity === "working"` (`:1805-1818`). A repeat wait then returns early at `:1727`, and `notifiedAt` stops a second notice at `:1833`.

**Decisions.**

- **What counts as leaving?**
  - **`idle`, `working` or `stopped`, but not `unknown` (recommended).**
    - Pros: an unreadable state cannot end an episode and re-notify.
    - Cons: a quick waiting → idle → waiting flap is a new episode, which the 20 s debounce absorbs.
  - **Any state other than `waiting`.**
    - Pros: simpler.
    - Cons: a read failure on a remote node (`unknown`, `:1800-1803`) would clear it and re-notify.

## Related

- [Coordinator report, 4.2 (B6)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
