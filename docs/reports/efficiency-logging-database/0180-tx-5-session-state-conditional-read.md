# Session-state reads have no conditional path from the bridge

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: measure bridge reads per state poll before changing the path. Status: open.
2. **Add a bridge state revision**: let the backend send `knownToken` to the bridge for state. Status: open (depends on 1).
3. **Cache the composer catalogue separately**: stop hashing the model catalogue on every poll. Status: open (depends on 1).

### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: task 4, which holds this finding, needs a baseline first.

**Investigation.** The progressive read phase timings (`ProgressiveReadPhaseTimer` in `apps/backend/src/core/native-agent-transcript-projection.ts`) separate source time from normalising time.

**Decisions.** None: the decision was made in 1202.

### 2. Add a bridge state revision

**Problem.** Every state poll fetches the whole session state from the bridge, even when the client's token will match.

**Context.** Transcript summaries already have this: `readHttpBridgeTranscriptSnapshot` sends `knownToken` (`apps/backend/src/core/http-bridge-progressive.ts:150`).

**Investigation.** `readHttpBridgeSessionState` (`http-bridge-progressive.ts:217`) fetches `/session` or `/status`, plus `/config` for Codex and `/queue` for Pi, with no condition. `readProgressiveSessionState` also reads interactions, the queue and a steer probe each time. No file under `bridges/*/src` names `knownToken` or `If-None-Match` directly.

**Decisions.**

- **What carries the condition?**
  - **A bridge state revision the backend sends as `knownToken` (recommended).**
    - Pros: the same contract as transcripts; an older bridge ignores it and answers whole.
    - Cons: every bridge must bump the revision on all state changes, and a missed bump shows stale state, so each needs a test.
  - **An HTTP `ETag` per route.**
    - Pros: standard.
    - Cons: Codex and Pi read two routes per state, so two tags to reconcile into one answer.

### 3. Cache the composer catalogue separately

**Problem.** The state token hashes `JSON.stringify(value)`, including the whole `composer.models` catalogue, on every poll.

**Context.** The catalogue rarely changes and is also served by discovery.

**Investigation.** The hash is at `native-agent-transcript-projection.ts:3418-3420`. `composer` is part of the view (`:3319`), built by `projectionComposer` (`:3149`).

**Decisions.**

- **How to stop re-serialising it?**
  - **Key the catalogue by a revision and hash the revision (recommended).**
    - Pros: the report's fix; the wire shape is unchanged.
    - Cons: a catalogue change must always move the revision.
  - **Memoise the catalogue's encoding through `encodedValue`.**
    - Pros: no new revision.
    - Cons: needs the catalogue to keep its object identity across reads, which a parsed bridge response does not.

## Constraints and rationale

- Decided 2026-11-01 (1202 task 1): baseline first.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any new cache needs byte and count bounds; metrics stay content-free.
- A bridge answering "unchanged" must still reach the backend's interaction and queue reads, which do not live in the bridge's state.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-5)
- [1202 tasks 1 and 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0170](0170-gw-1-native-session-read-round.md): the client side of the same poll
