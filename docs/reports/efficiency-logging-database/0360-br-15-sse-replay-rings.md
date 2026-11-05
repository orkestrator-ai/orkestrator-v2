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
- 1202's recommended order is after [0250](0250-br-7-codex-running-tool-cards.md).

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-15)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

## Outcome

Checked back against the code on 2026-11-05 before this file was deleted. The build began at `69a3b4ca5`, where every finding and line number above still held: Codex's `EventRing` at `bridges/codex-bridge/src/event-ring.ts:62` with `collapseSuperseded` at `:148`, Claude's `createReplayBuffer` at `bridges/claude-bridge/src/routes/events.ts:101` serialising on append (`:109`) and filtering on read (`:138`), and the per-subscriber `Buffer.byteLength(frame.data)` (`:280`) and live frame measurement (`:390-396`). No to-do was needed.

| Task | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| 1. Move one ring into the protocol package | Done | Codex's ring moved to `packages/protocol/src/node/event-ring.ts` (`@orkestrator/protocol/node/event-ring`), and Claude's `createReplayBuffer` in `bridges/claude-bridge/src/routes/events.ts` is now built on it, fed the emitter's own revisions through the new `appendAt` and `advanceTo`. Claude adopts the collapse: `supersedeReplayFrame` turns every earlier `message.updated` and `message.patched` frame for a message into a cursor-only entry once a newer full `message.updated` is retained, replayed as `bridge.cursor` (the frame Codex sends). The ring's supersede scan now continues past a replaced entry and stops at one already collapsed, so one snapshot collapses the patches since the last one. Tests: `packages/protocol/src/node/event-ring.test.ts` ("EventRing supersede", "EventRing with an outside sequence", and the moved Codex cases); `bridges/claude-bridge/src/routes/events.test.ts` ("SSE replay collapse", "replays collapsed frames as cursor frames before the newest snapshot", "an observation subscriber's replay is unchanged by the collapse"); Codex's `sse-replay.test.ts` and `index-coverage.test.ts` pass unchanged. |
| 1. Decision: move the rings as part of BR-15, or separately after BR-7 | Done, recommended option | Taken separately after BR-7, as recommended. BR-7 is done (0250 is marked finished in the index, and 1202 task 6 records it done 2026-11-04), so this batch is that separate task, with its own replay tests. |
| 2. Stop re-measuring frames per subscriber | Done | `serializeEvent` caches each event's data with its UTF-8 `dataBytes`, measured once and shared by the ring and every live subscriber. `SseFrame.dataBytes` carries it, and `createBoundedSseWriter` measures `data` only when it is absent. The ring weight (`bytes`) still adds the event name, so the writer limits on `dataBytes` as before. Tests in `events.test.ts`: "uses a frame's known byte count rather than measuring its data again" and "measures an event's encoded bytes once with its serialization". |
| Constraint: every ring keeps byte and count bounds, and a collapse never hides a gap from a client's cursor | Done | Claude keeps 512 frames and 4 MiB. Collapsed entries keep their revisions, so the replay stays dense. A revision jump in `appendAt`, `advanceTo` or `advance` drops what is retained, so a client behind it gets `replay.required` (Claude) or `session.reconcile-required` (Codex) rather than a replay with a hole. Tests: "a jump past the next revision drops what a replay could no longer cover densely", "advanceTo moves the cursor without retaining and drops what it strands", "advance drops retained events, which would otherwise hide its revision", "a skipped revision makes an older cursor require a reset". |
| Constraint: 1202's order, after 0250 | Done | 0250 (BR-7) was finished first. |
| Compatibility with older backends and clients | Done | An observation replay (`?observe=1`), the only stream the backend reads, still gets one content-free frame per revision under its original type, so no backend sees a change. In full mode the only new frame is `bridge.cursor`, which Codex already sends and the backend's observer already treats as transport. Nothing in `apps`, `packages` or `e2e` reads Claude's full-mode frames. |
