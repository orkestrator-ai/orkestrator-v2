# A delegation closing during a wake pass waits for the next sweep

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Run one more pass when asked mid-pass**: a call made while a pass runs schedules one further pass after it. Status: open.

### 1. Run one more pass when asked mid-pass

**Problem.** A worker that finishes while another worker's wake is being delivered can wait up to a minute to report.

**Context.** A pass can take seconds: `ensureMainConversation` does a full mailbox sync (`coordinator-service.ts:1198`, `:325`) and the notice path reads a transcript excerpt (`:1265-1278`). The fallback is `coordinator-repair`, every 60 s (`docs/architecture/recurring-work.md`, B11).

**Investigation.** `deliverDelegationWakes` (`coordinator-service.ts:1172-1179`) returns the promise of the running pass. That pass read its list once at `:1182`, before the new delegation closed. Parallel workers are the normal case for a coordinator, so this is reachable without a fault.

**Decisions.**

- **How to rerun?**
  - **A `rerunRequested` flag that loops the pass until it is clear (recommended).**
    - Pros: coalesces any number of calls into one extra pass; callers keep awaiting one promise.
    - Cons: the awaited promise can last longer; a caller holding `withAgentMailWorkerAdmission` must not await it (today's callers await after the lock at `:879-918`).
  - **Re-read the list inside the loop after each item.**
    - Pros: no flag.
    - Cons: one store read per delivered wake, and it makes the loop's termination depend on new closes.

## Related

- [Coordinator report, 4.2 (B3)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [0010-delegation-wake-loops-stop-on-first-error.md](0010-delegation-wake-loops-stop-on-first-error.md): touches the same pass
