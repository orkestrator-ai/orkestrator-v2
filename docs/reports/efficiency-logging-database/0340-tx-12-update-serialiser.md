# Already-encoded rows are stringified again on the way out

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Splice memoised rows into the response**: an update serialiser that reuses per-message JSON. Status: open.
2. **Count `revisedMessages` through the memo**: stop serialising them to measure a view. Status: open.

### 1. Splice memoised rows into the response

**Problem.** A transcript answer's rows were each encoded and memoised to size and hash them, but the gateway serialises the whole result again to send it.

**Context.** `/invoke` is generic: it knows nothing about the shape of what a command returns.

**Investigation.** `apps/backend/src/gateway-handlers.ts:133` runs `JSON.stringify({ result })` for every command, then sends the string through `serializedJsonResponse` (`:141`). The memo is `encodedValue` in `apps/backend/src/core/native-agent-projection-encoding.ts:26`.

**Decisions.**

- **How does the handler reach the memo?**
  - **Let a command return a pre-serialised result the handler splices in (recommended).**
    - Pros: other commands are untouched; the update serialiser lives next to the memo.
    - Cons: a new marker type crossing the backend boundary, and every non-gateway caller of those commands must still get a plain object.
  - **Leave it.**
    - Pros: a plain and safe path. A window is at most 512 KiB, so the gain per poll is bounded.
    - Cons: the cost stays per changed read.

### 2. Count `revisedMessages` through the memo

**Problem.** `encodedBytesWithMessages` memoises `messages`, but `revisedMessages` sits in `rest`, which is serialised on each measure.

**Context.** Revised rows are full messages outside the live tail, so they can be large.

**Investigation.** `native-agent-projection-encoding.ts:131-138` does `JSON.stringify(rest)`. It runs at `native-agent-transcript-projection.ts:2637` and on each delta (`:3029`).

**Decisions.** None: count the field with `encodedArrayBytes`, as `messages` is. It is the report's fix and does not alter any output.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the byte budgets rely on this measure, so it must not undercount.
- The spliced JSON must be byte-identical in meaning to `JSON.stringify`, including `undefined` fields dropped.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-12)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
