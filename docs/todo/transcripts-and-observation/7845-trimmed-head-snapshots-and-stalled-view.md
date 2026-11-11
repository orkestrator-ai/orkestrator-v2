# A part-trimmed head over a million characters: whole snapshots, then a stalled view

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`, with the measurements of to-do 6260 task 3 (retired 2026-11-11; read it with `git show 1fd391e3a:docs/todo/transcripts-and-observation/6260-projection-hashing-measurements.md`, "Measuring a part-trimmed head on a loopback model").

### Tasks

1. **Find why a recovered head row over about a million characters reaches readers as whole snapshots**, and send deltas again or bound the cost. Status: open.
2. **Find why the view stops moving once the row passes about 1.7 million characters**, and make a streaming view advance at least every few seconds. Status: open.
3. **Measure before and after with the loopback spec's `trimmed-head` scenario.** Status: open (depends on 1 and 2).

### 1. Whole snapshots for a recovered head row over about a million characters

**Problem.** While a session streams one response larger than the 512 KiB window, the bridge sends a part-trimmed head and the backend recovers the exact row with one `/messages` read a second (`PROGRESSIVE_HYDRATION_SETTLE_MS`). Up to about a million streamed characters, each recovered transcript reached the view as a `delta`. Past that, it reached every reader as a whole transcript snapshot of about 3 MB. With one viewer that was 6 snapshots and 17.5 MB in 20 s; with two, 20 snapshots and 63 MB per viewer in 20 s.

**Context.** Both readers share one view key, so recovery runs once a second however many readers there are. A reader whose token is not the newest view's gets a delta only from the TX-1 ring of superseded views (`native-agent-transcript-delta-bases.ts`). That ring empties for a key whenever a superseded view would cost more than `NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES` (2 MiB) to keep. A recovered head row over about a million characters is more than 2 MiB once encoded, and consecutive views do not share it because it grows on every recovery. The bytes go over loopback to a local renderer, but a remote client pays them over its link.

**Investigation.** Measured only, 2026-11-11, on an isolated credential-free `dev:test` profile with the real Claude CLI against a loopback model (6260's figures). The 2 MiB key bound is a hypothesis from reading the code: no log or counter confirmed that the ring was emptied. With one viewer, a snapshot also needs the reader to be behind the newest view. That happens when the preview and a recovery commit alternate between two polls, but that was not confirmed either. First step: count `record` calls that `forget` a key for size (a content-free counter or a test with a 3 MB row) and confirm.

**Decisions.**

- **What to change once the cause is confirmed?**
  - **Charge a superseded view only for the rows its successor dropped, and let a grown row replace its predecessor in the ring rather than empty it (recommended).**
    - Pros: keeps deltas for the usual case of one long streaming row; the ring stays bounded by count and bytes.
    - Cons: a delta of a changed 3 MB row is still about 3 MB unless the delta can carry a row's appended text, so the saving depends on task 1's protocol answer too.
  - **Raise the per-key bound.**
    - Pros: one constant.
    - Cons: moves the cliff rather than removing it, and raises the memory every streaming session may hold.
  - **Leave it.**
    - Pros: nothing to change; rows this large are rare.
    - Cons: a remote client watching such a turn pays tens of megabytes a minute.

### 2. The view stalls past about 1.7 million characters

**Problem.** Past about 1.7 million streamed characters the view almost stopped: one transcript change in 20 s per viewer, although the bridge served 20 recovery reads in that window. The user sees a transcript that lags further and further behind a turn that is still streaming, until the turn ends.

**Context.** A recovery's result is committed only if the key's source token has not moved while it was in flight (`scheduleIncompleteProgressiveHydration` in `native-agent-transcript-projection.ts`), and while one is pending the view holds the last recovered transcript (`holdPreview`). The bridge's mean time for one recovery read grew with the row: 6–8 ms under a million characters, 15 ms at 1.3–1.7 million and 28 ms beyond, before the backend parses the result.

**Investigation.** Measured only (6260's figures). Hypothesis: once reading and parsing the exact row outlasts the gap between two bridge revisions, every result is discarded as stale. The first attempt holds the preview and a newer token schedules the next one, so the view keeps the old recovered transcript. Not confirmed: log, content-free, why each recovery ended (committed, stale token, no fuller transcript, read failed), or reproduce it with the provider fake in `native-agent-service-projection-hashing.test.ts` by delaying `messages`.

**Decisions.**

- **How should a streaming view advance when exact recovery cannot keep up?**
  - **Commit a recovered transcript even when the token moved, if it is no older than what the view shows, and let the next recovery replace it (recommended).**
    - Pros: the view advances once per recovery as designed; nothing older than the shown view is ever committed.
    - Cons: the committed view may lag the newest revision by one read, which the next one closes; the commit check must compare revisions, not tokens.
  - **Stop holding the preview after a stale result, so the trimmed tail shows while it streams.**
    - Pros: the view always moves.
    - Cons: shows the part-trimmed head (the start of the row cut off) until the turn ends.
  - **Leave it.**
    - Pros: nothing to change.
    - Cons: a very long single response looks frozen while it streams.

### 3. Measure before and after

**Problem.** Tasks 1 and 2 need the same evidence as 6260 task 3, before and after the change.

**Context.** `e2e/agent-testing/conditional-reads-live.spec.ts` with `E10_SCENARIO=trimmed-head` reproduces both on a credential-free profile in about 3.5 minutes; `E10_READY_CHARS=1300000` starts measuring late enough to reach the stall ([agent-testing.md](../../development/agent-testing.md#live-conditional-reads-loopback-models)).

**Investigation.** Not run beyond 6260's three runs.

**Decisions.**

- **Which runs?**
  - **The default `trimmed-head` run and one with `E10_READY_CHARS=1300000`, on the commit before and after (recommended).**
    - Pros: covers both size bands; no billed turn.
    - Cons: about 7 minutes per commit.
  - **Only the late-start run.**
    - Pros: half the time.
    - Cons: misses whether the under-a-million band still gets deltas.

## Current state

Found 2026-11-11 by 6260 task 3. The one-second recovery interval is right and stays; what fails is delivery to readers above about a million characters, and then the view itself above about 1.7 million.

## Related

- 6260 task 3 (retired 2026-11-11): the measurements, `git show 1fd391e3a:docs/todo/transcripts-and-observation/6260-projection-hashing-measurements.md`.
- [native-transcripts.md, "Incomplete previews and exact recovery"](../../architecture/native-transcripts.md#incomplete-previews-and-exact-recovery).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): how often real sessions reach a part-trimmed head (6260 (retired) task 3).
