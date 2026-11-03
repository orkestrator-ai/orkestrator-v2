# A transcript delta can only be built from the newest cached view

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: measure snapshot and delta rates with a lagging client and a second viewer. Status: open.
2. **Keep a small ring of recent views per key**: build a delta from whichever base the client holds. Status: open (depends on 1).

### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: structural tasks, including TX-1, need a baseline first.

**Investigation.** The `recordProgressiveMetric` outcomes (`delta`, `snapshot`, `cached`) in `apps/backend/src/core/native-agent-transcript-projection.ts` are the natural measure. No figures for them are recorded in 1202.

**Decisions.** None: the decision was made in 1202.

### 2. Keep a small ring of recent views per key

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

## Constraints and rationale

- Decided 2026-11-01 (1202 task 1): baseline first.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, and the new ring needs byte and count bounds.
- A base from another history epoch or provider session must never produce a delta (the check at `native-agent-transcript-projection.ts:3015-3016`).

## Needs verification

- How often clients actually lag or share a session. Reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-1)
- [1202 tasks 1 and 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0050 transcript history efficiency](../../todo/transcripts-and-observation/0050-transcript-history-efficiency.md)
