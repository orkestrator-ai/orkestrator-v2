# Whether the "Waiting on" line costs prompt cache

From coordinator report C5, part `0170` (Add the project name and open work to the context block): its Needs verification item. Both of that part's tasks were built.

## Task analysis

Analysed 2026-11-05 against `main` at `ce7989a50`.

### Tasks

1. **Measure the cache cost of the changing line** (part `0170`, Needs verification): whether a line that changes turn to turn lowers the cache hit rate, on each provider. Status: open.

### 1. Measure the cache cost of the changing line

**Problem.** A main coordinator with open delegations now gets a `Waiting on` line in its context block, which changes as workers start and finish. A provider's prompt cache stops at the first changed byte, so a changing line could make every later turn pay for text that used to be cached.

**Context.** The report chose always showing the line, capped at a few names and omitted when nothing is open, over relying on the agent to call `list_workflows`, because a model that has forgotten what it launched may not think to ask. It noted the cost and put the line at the end of the block for that reason. `buildCoordinatorContext` (`packages/protocol/src/coordinator-context.ts`) does so: only the prompt follows it. The revision, branch, commit and checkout update lines ahead of it already change turn to turn. `cacheReadTokens` is already captured per turn, and [0025](0025-multi-review-panel-value.md) records what it means on each provider.

**Investigation.** Not done: it can only be measured with real provider turns, and this work could spend no billed turns. What to compare, per provider: `cacheReadTokens` on consecutive coordinator turns with the line absent, stable, and changing.

**Decisions.**

- **What to do with the result?**
  - **Keep the line as built unless the measurement shows a real loss, then drop the names and keep the count (recommended).**
    - Pros: a count changes less often than names and still prompts the model to ask; the fix is one function.
    - Cons: a model that has lost its history no longer sees what it launched, only that there is something.
  - **Move the line out of the block, onto the prompt after the closing tag.**
    - Pros: certain to sit after everything cacheable.
    - Cons: `stripCoordinatorContext` would no longer hide it from the transcript, so the user would see it in their own message.

## Related

- [Coordinator report, 4.3 (A5)](../../reports/2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md)
- [The context block](../../architecture/coordinator.md#the-context-block)
