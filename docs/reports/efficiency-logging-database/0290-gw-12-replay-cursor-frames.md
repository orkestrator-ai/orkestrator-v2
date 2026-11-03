# Scoped stream replay writes one cursor frame per skipped event

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Collapse skipped replay frames into one cursor**: track the highest skipped revision and emit it once. Status: open.

### 1. Collapse skipped replay frames into one cursor

**Problem.** A filtered client reconnecting after a burst of unrelated events receives one cursor frame per event it does not care about.

**Context.** Live traffic already solved this: `flushOmittedCursor` costs one frame per keepalive rather than one per omitted event (`apps/backend/src/gateway-events.ts:109`).

**Investigation.** `writeReplayFrame` writes a cursor for each non-matching frame (`gateway-events.ts:214`), called per frame in the replay loop (`:316-319`). A matching frame carries its own newer id, so a pending skipped revision is superseded by it, which is what `emit` already relies on (`:58-60`).

A related cost: `replayFitsClientBudget` (`:226-233`) sums `encodedBytes` for every frame, including those a filtered client only gets a small cursor for, so a filtered client can be told `replay-too-large` when its real replay is small.

**Decisions.**

- **When to emit the cursor?**
  - **Only at the end of the replay, if the last frames were skipped (recommended).**
    - Pros: fewer frames than the report's "before the next matching frame", since that frame's own id already advances the client.
    - Cons: depends on every matching replay frame carrying an id, which it does today.
  - **Before each next matching frame and at the end, as the report says.**
    - Pros: the cursor never lags a matching frame, even if a later change drops ids.
    - Cons: one extra frame per run of skips.
- **Fix the replay budget for filtered clients at the same time?**
  - **Yes: count a small cursor for skipped frames (recommended).**
    - Pros: same loop; removes a needless reconcile.
    - Cons: the projected figure must still be an upper bound, or the guard it exists for fails.
  - **Leave it.**
    - Pros: a smaller change.
    - Cons: a filtered client keeps reconciling when it need not.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable. The final cursor must leave the client exactly as far on as the frames it replaces.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-12)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
