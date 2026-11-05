# Two SSE replay rings with uneven quality

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Move one ring into the protocol package**: Claude adopts Codex's `EventRing` or its behaviour. Status: open.
2. **Stop re-measuring frames per subscriber**: reuse the byte count a Claude frame already has. Status: open.

### 1. Move one ring into the protocol package

**Problem.** Codex's ring collapses superseded frames. Claude's does not, so a reconnecting Claude client replays every intermediate frame, and the ring fills faster.

**Context.** BR-15's transcript half is done (see Current state). The rings were left because changing Claude's replay changes what a client receives, which the helper move was required not to do.

**Investigation.** Codex: `EventRing` (`bridges/codex-bridge/src/event-ring.ts:62`), with `collapseSuperseded` (`:148`). Claude: `createReplayBuffer` (`bridges/claude-bridge/src/routes/events.ts:101`) serialises every event on append (`:109`) and filters on read (`:138`). Nothing shared exists in `packages/protocol/src/node`.

**Decisions.**

- **Should the rings move as part of BR-15?** Open in 1202; its recommendation is carried here.
  - **Separately, after BR-7 (recommended).**
    - Pros: Claude's ring adopting the collapse changes what a reconnecting client is replayed, which needs its own replay tests; the transcript helpers did not depend on it.
    - Cons: BR-15 stays half open.
  - **Move Codex's `event-ring.ts` into protocol now and point Claude at it.**
    - Pros: closes BR-15.
    - Cons: a behaviour change to Claude's SSE replay in a task meant to leave output unchanged.

### 2. Stop re-measuring frames per subscriber

**Problem.** Each Claude subscriber measures each frame again before writing it.

**Context.** The backend subscribes only to `?observe=1`, whose frames are tiny, so the real saving is small.

**Investigation.** `Buffer.byteLength(frame.data)` runs in the per-connection writer (`routes/events.ts:280`), and a live subscriber builds and measures its own frame (`:390-396`), although a `ReplayFrame` has `bytes`.

**Decisions.** None: pass the known count. The ring's `bytes` also counts the event type, so the writer needs the data length itself or a small change in what it limits.

## Current state

Done, checked in code, in #1593 (`e668f0a6d`): the Pi, Cursor and ACP transcript helpers live in `packages/protocol/src/node` (`bridge-transcript-text.ts`, `bridge-transcript-bounds.ts`, `transcript-budget.ts`), and BR-4 to BR-6 were fixed there once.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): every ring has byte and count bounds, and missed events stay detectable. A collapse must not hide a gap from a client's cursor.
- 1202's recommended order is after BR-7, which is done ([1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md#6-bridge-hot-paths)).

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-15)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
