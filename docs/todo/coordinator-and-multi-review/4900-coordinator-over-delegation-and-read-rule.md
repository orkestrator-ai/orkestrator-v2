# Coordinator over-delegation and the read rule

From coordinator report C5, part `0460` (The prompt nudges toward over-delegation): its task 2, which the report held back for a live check, and its Needs verification item. Task 1 of that part, preferring an idle worker, was built.

## Task analysis

Analysed 2026-11-05 against `main` at `ce7989a50`.

### Tasks

1. **Find out whether over-delegation happens** (part `0460`, Needs verification): read real coordinator transcripts for how often a coordinator launches a worker for a read. Status: open.
2. **Soften the read rule** (part `0460`, task 2): "even when it only reads" applies when the read is expected to be long. Status: open (depends on 1).

### 1. Find out whether over-delegation happens

**Problem.** A fresh worktree, with its setup scripts, can be started for each question when an idle worker could answer, or when the coordinator could have read the file itself. The report marked this plausible, not observed, and no transcript was read for it.

**Context.** The report's finding is its A7. The coordinator is read-only and long work belongs in a worker, which is why the Scope line sends reads there. Since the report, the routing and environment-choice rules have added more on how to start work. `COORDINATOR_ROUTING_RULE` now offers `send_prompt_to_tab` and `launch_job` on an idle worker before `launch_environment`, so the check also shows whether that clause changed anything.

**Investigation.** Not done: it needs transcripts from real use. The build worker runs beside the user's production instance and must not read its data directory, and this work could spend no billed provider turns, so an isolated profile could not produce any either. What to count, per coordinator conversation: `launch_environment` calls whose worker prompt asks only for reading or research and whose worker made no commit, against all launches; and how many of those had an idle worker in the same project at the time.

**Decisions.**

- **Where does the evidence come from?**
  - **The user's own coordinator transcripts, read with their approval (recommended).**
    - Pros: real behaviour on real projects, which is what the rule has to fit; needs no new provider spend.
    - Cons: needs the user, or an agent they authorize, to read real conversations.
  - **A scripted run in the opt-in live coordinator suite ([0024](0024-coordinator-live-conformance.md)).**
    - Pros: repeatable, and works on an isolated profile.
    - Cons: billed turns, and a scripted question measures the script as much as the habit.

### 2. Soften the read rule

**Problem.** The Scope line sends any "multi-file investigation" to a worker "even when it only reads".

**Context.** The same sentence stops a read-only coordinator doing long work itself, which is its purpose. It is stated in `buildCoordinatorContext` (`packages/protocol/src/coordinator-context.ts`), where a test holds the block's size, so a rewording that stays short needs no other change. `Scope:` is asserted by `native-agent-service-base.test.ts` ("belongs in a worker environment you launch").

**Investigation.** The report's recommendation was to reword only after the live check in task 1, so this stays open. The text is unchanged from the report.

**Decisions.**

- **Change it now?**
  - **Reword after task 1's check of how often coordinators launch for reads (recommended).**
    - Pros: evidence first for a prompt that sets the role.
    - Cons: needs transcripts from real use.
  - **Reword now as the report suggests.**
    - Pros: one line.
    - Cons: may push long work back into the coordinator's turn, which the line is there to prevent.

## Needs verification

Whether over-delegation happens in practice (task 1).

## Related

- [Coordinator report, 4.3 (A7)](../../reports/2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [Routing](../../architecture/coordinator.md#routing) and [The context block](../../architecture/coordinator.md#the-context-block)
