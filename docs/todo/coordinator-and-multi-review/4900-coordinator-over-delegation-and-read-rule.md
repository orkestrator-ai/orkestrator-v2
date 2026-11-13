# Coordinator over-delegation and the read rule

From coordinator report C5, part `0460` (The prompt nudges toward over-delegation): its task 2, which the report held back for a live check, and its Needs verification item. Task 1 of that part, preferring an idle worker, was built.

## Task analysis

Analysed 2026-11-05 against `main` at `ce7989a50`.

### Tasks

2. **Soften the read rule** (part `0460`, task 2): "even when it only reads" applies when the read is expected to be long. Status: blocked (waits on 7568: 4900 task 1 transcript count).

### 2. Soften the read rule

**Problem.** The Scope line sends any "multi-file investigation" to a worker "even when it only reads".

**Context.** The same sentence stops a read-only coordinator doing long work itself, which is its purpose. It is stated in `buildCoordinatorContext` (`packages/protocol/src/coordinator-context.ts`), where a test holds the block's size, so a rewording that stays short needs no other change. `Scope:` is asserted by `native-agent-service-base.test.ts` ("belongs in a worker environment you launch").

**Investigation.** The report's recommendation was to reword only after the check of real transcripts (task 1, now on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)), so this stays open. The text is unchanged from the report. Since the report, `COORDINATOR_ROUTING_RULE` offers `send_prompt_to_tab` and `launch_job` on an idle worker before `launch_environment`, so the count also shows whether that clause changed anything.

**Decisions.**

- **Change it now?**
  - **Reword after task 1's check of how often coordinators launch for reads (recommended).**
    - Pros: evidence first for a prompt that sets the role.
    - Cons: needs transcripts from real use.
  - **Reword now as the report suggests.**
    - Pros: one line.
    - Cons: may push long work back into the coordinator's turn, which the line is there to prevent.

## Related

- Coordinator report, 4.3 (A7) (`git show 413bd6219:docs/reports/2026-10-27-coordinator.md`)
- [coordinator-live-conformance.md](../../development/coordinator-live-conformance.md) (to-do 0024, retired)
- [Routing](../../architecture/coordinator.md#routing) and [The context block](../../architecture/coordinator.md#the-context-block)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, counting read-only delegations in real coordinator transcripts) moved there on 2026-11-10.
