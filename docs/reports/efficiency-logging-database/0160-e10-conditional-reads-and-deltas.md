# E10: Conditional reads and deltas

This file combines 3 reports into one batch to build together. Waiting on the baseline. `0190` links to `0160`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0160](#0160-a-transcript-delta-can-only-be-built-from-the-newest-cached-view) | Low | TX-1: A transcript delta can only be built from the newest cached view |
| [0180](#0180-session-state-reads-have-no-conditional-path-from-the-bridge) | Low | TX-5: Session-state reads have no conditional path from the bridge |
| [0190](#0190-bridge-transcript-windows-are-always-sent-whole) | Low | TX-6: Bridge transcript windows are always sent whole |

## Shared baseline

The report measured nothing, and the maintainer gated this work on numbers. Decided 2026-11-01 in 1202 task 1: structural tasks, including TX-1, and task 4, which holds TX-5 and TX-6, need a baseline first. The decision and the method are recorded there, so nothing is left to decide here.

| Part | What to measure | Where to read it |
| --- | --- | --- |
| `0160` | Snapshot and delta rates with a lagging client and a second viewer | The `recordProgressiveMetric` outcomes (`delta`, `snapshot`, `cached`) in `apps/backend/src/core/native-agent-transcript-projection.ts`. No figures for them are recorded in 1202. |
| `0180` | Bridge reads per state poll | The progressive read phase timings (`ProgressiveReadPhaseTimer` in `apps/backend/src/core/native-agent-transcript-projection.ts`) separate source time from normalising time. |
| `0190` | Bridge transcript bytes while a turn streams | Not started; the method is 1202 task 1's. |

## 0160: A transcript delta can only be built from the newest cached view

### Task analysis

#### Tasks

1. **Capture the baseline**: measure snapshot and delta rates with a lagging client and a second viewer. See [Shared baseline](#shared-baseline). Status: done 2026-11-05 with a fake bridge; the real-stack run is todo 6680 task 1.
2. **Keep a small ring of recent views per key**: build a delta from whichever base the client holds. Status: done 2026-11-04 without the baseline, at the ticket's request; both decisions below took the recommended option.

#### 2. Keep a small ring of recent views per key

**Problem.** While a turn streams, a client that fell behind once keeps getting whole snapshots (up to 512 KiB), one poll stale. Two viewers of one session never get a delta.

**Context.** Views share row objects through `reuseUnchangedMessages`, so a ring costs mostly arrays. The sync path already keeps bounded revisions per key, which is the model to follow.

**Investigation.** `progressiveTranscriptCache` holds one entry per key (`native-agent-transcript-projection.ts:468`), replaced in `commitProgressiveTranscript` (`:2603`, `:2640`). A delta is built only when `input.knownToken === previous.token` (`:3012-3017`). Before that, any other token gets the cached view as a snapshot while a background read moves the cache on (`:2973-2981`), which is what keeps a lagging client behind. The sync model is `recordSyncProjection` (`:1491-1518`), with limits of 128 revisions, 2 MiB per revision and 32 MiB in total (`native-agent-service-shared.ts:744-746`). `state.revisions.find` (`native-agent-transcript-projection.ts:3806`) is its lookup.

**Decisions.**

- **How many bases, and bounded how?** 1202 recommends this; the maintainer has not marked it decided.
  - **A ring of 4 to 8 views per key, bounded by count and bytes like `state.revisions` (recommended).**
    - Pros: views share rows; one pattern in the file; an unknown token still falls back to a snapshot.
    - Cons: more memory per hot session, and the bytes need honest accounting, because rows shared with the newest view should not be charged twice.
  - **Keep one base and send a snapshot to anyone behind.**
    - Pros: no change.
    - Cons: the problem stays.
- **Should the early cached answer (`native-agent-transcript-projection.ts:2973`) also use the ring?**
  - **Yes: try the ring before answering with a cached snapshot (recommended).**
    - Pros: this is the path a lagging client actually takes, so a ring that ignored it would rarely help.
    - Cons: the answer may be one read stale, as it is today.
  - **Only build ring deltas after the fresh read.**
    - Pros: always current.
    - Cons: the client waits for a provider read on each poll.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, and the new ring needs byte and count bounds.
- A base from another history epoch or provider session must never produce a delta (the check at `native-agent-transcript-projection.ts:3015-3016`).

### Needs verification

- How often clients actually lag or share a session. Reasoned, not measured.

## 0180: Session-state reads have no conditional path from the bridge

### Task analysis

#### Tasks

1. **Capture the baseline**: measure bridge reads per state poll before changing the path. See [Shared baseline](#shared-baseline). Status: done 2026-11-05 with a fake bridge; the real-stack run is todo 6680 task 1.
2. **Add a bridge state revision**: let the backend send `knownToken` to the bridge for state. Status: not done 2026-11-05, measured and not worth building; todo 6680 task 2.
3. **Cache the composer catalogue separately**: stop hashing the model catalogue on every poll. Status: not done 2026-11-05, measured and not worth building; todo 6680 task 3.

#### 2. Add a bridge state revision

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

#### 3. Cache the composer catalogue separately

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

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any new cache needs byte and count bounds; metrics stay content-free.
- A bridge answering "unchanged" must still reach the backend's interaction and queue reads, which do not live in the bridge's state.

## 0190: Bridge transcript windows are always sent whole

### Task analysis

#### Tasks

1. **Capture the baseline**: measure bridge transcript bytes while a turn streams. See [Shared baseline](#shared-baseline). Status: done 2026-11-05 with a fake bridge; the real-stack run is todo 6680 task 1.
2. **Add a v2 `delta` answer**: a bridge answers with changed rows, the id order and `revisedMessages`. Status: not done 2026-11-05, measured and not worth building yet; todo 6680 task 4.

#### 2. Add a v2 `delta` answer

**Problem.** Any change re-sends and re-parses up to 100 rows or 512 KiB between bridge and backend, when usually only the tail row moved.

**Context.** The bridges already track revised rows (`RecentlyRevisedRows`), and the backend already sends a `knownToken`.

**Investigation.** `readHttpBridgeSummaryTranscript` (`apps/backend/src/core/http-bridge-transcript-v2.ts:160`) handles `unchanged` (`:197`) and otherwise a whole snapshot. The bridges answer through the shared code in `packages/protocol/src/node/bridge-transcript-summary.ts`, whose contract tests (`bridge-transcript-contract.ts:335-365`) cover `knownToken` for unchanged and changed reads, so a fix lands in one place plus each bridge's source.

**Decisions.**

- **What is the base of a delta?**
  - **The `knownToken`, falling back to a snapshot on an unknown base (recommended).**
    - Pros: the report's fix; it mirrors the backend's own delta and needs a small ring on each bridge.
    - Cons: every bridge holds recent views; a new wire form needs a capability check and a version-compatibility entry.
  - **Keep whole windows and rely on TX-1 and the client delta.**
    - Pros: no bridge change.
    - Cons: the loopback cost stays. It is CPU rather than remote bandwidth, so this is a fair choice if the baseline shows it is small.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a transcript row is one model response, so deltas must carry `revisedMessages` for rows outside the live tail; missed events stay detectable; any ring needs byte and count bounds.

## Outcome

Checked back on 2026-11-05 against `main` at `cbe0f9a5b`. The baseline was taken with `apps/backend/scripts/conditional-reads-baseline.ts` (the real backend and HTTP bridge client against a fake bridge; no provider turn), because a `dev:test` profile cannot stream a turn without one. Nothing was built: 0160 task 2 was already done and the baseline confirms it, and 0180 tasks 2 and 3 and 0190 task 2 each measured well under 1% of a core per streaming session. The figures, the decisions and the real-stack run are [todo 6680](../../todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md); the item-by-item outcome is the [closing check of E10](0000-index.md#closing-check-of-e10-conditional-reads-and-deltas).

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-1, TX-5, TX-6)
- [1202 tasks 1 and 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0050 transcript history efficiency](../../todo/transcripts-and-observation/0050-transcript-history-efficiency.md)
- [1202 tasks 1 and 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [1202 task 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md): E8, the client side of the same poll, is done
- [0160](#0160-a-transcript-delta-can-only-be-built-from-the-newest-cached-view): the backend's delta bases
