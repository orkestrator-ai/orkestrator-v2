# A part-trimmed head over a million characters: whole snapshots, then a stalled view

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`, with the measurements of to-do 6260 task 3 (retired 2026-11-11; read it with `git show 1fd391e3a:docs/todo/transcripts-and-observation/6260-projection-hashing-measurements.md`, "Measuring a part-trimmed head on a loopback model").

### Tasks

1. **Find why a recovered head row over about a million characters reaches readers as whole snapshots**, and send deltas again or bound the cost. Status: done (2026-11-13).
2. **Find why the view stops moving once the row passes about 1.7 million characters**, and make a streaming view advance at least every few seconds. Status: done (2026-11-13).
3. **Measure before and after with the loopback spec's `trimmed-head` scenario.** Status: done (2026-11-13).

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

Found 2026-11-11 by 6260 task 3. The one-second recovery interval is right and stays; what failed was delivery to readers above about a million characters, and then the view itself above about 1.7 million. Both causes were confirmed and fixed on 2026-11-13 (commit `c4ca3aeee`), and the `trimmed-head` measurement after the fix is below. Nothing agent-buildable is left.

### Confirmed causes

- **Task 1, the 2 MiB key bound.** `native-agent-transcript-delta-bases.test.ts`, "a viewer one view behind a head row over a million characters gets a small patch": a head row of about 3 MB encoded that grows on every read. Before the fix the viewer one view behind got a `snapshot` (the ring had been emptied by `record`, because the superseded view alone cost more than `NATIVE_TRANSCRIPT_DELTA_MAX_KEY_BYTES`); after it, a `delta` whose only change is a part-level patch of the head row, under 4 KB. Two `TranscriptDeltaBases` unit tests pin the new bound ("a base over the key bound replaces the ring rather than emptying it", "a recovered head row over a million characters keeps its base under the default bounds"). All three fail with the old `record` and pass with the fix.
- **Task 2, recoveries discarded as stale.** `native-agent-service-projection-hashing.test.ts`, "a recovery a newer revision overtook still advances the view": the provider fake holds the exact `messages` read until a newer part-trimmed revision has been polled. Before the fix the view stayed on the previous recovered transcript (the result was dropped because the source token had moved and the recovery entry had been replaced); after it, the view shows the overtaken recovery's transcript at once, and the newer revision's recovery replaces it on its own schedule. "A recovery older than the view it would replace is not committed" pins the other side: a complete snapshot that lands while the read is in flight is not overwritten by it.

### Measurement after the fix (task 3)

Measured 2026-11-13 on beelink (Linux) at `c4ca3aeee`, profile `e10-7845`, started with `--fixture --headless --no-agent-credentials --no-host-seed --agent-platforms claude` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`; stopped and reset afterwards. Command, per run: `ORKESTRATOR_AGENT_TEST_E10_BASELINE=1 E10_SCENARIO=trimmed-head mise run test:logged -- --name e10-trimmed-head -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts conditional-reads-live.spec.ts`, the second run with `E10_READY_CHARS=1300000`; both passed. The "before" rows are 6260's runs at `91cd5308e` (`git show 1fd391e3a:docs/todo/transcripts-and-observation/6260-projection-hashing-measurements.md`); they were not re-run, because the code they measured is unchanged up to this fix. Nine other builds shared the host, so the millisecond columns are indicative only; the answer counts and bytes do not depend on load.

| Run | Window (characters streamed) | Recovery reads | Bridge time per recovery read, mean | Renderer transcript answers per viewer | Renderer bytes per viewer |
| --- | --- | --- | --- | --- | --- |
| Before | One viewer, 0.60–1.04 M | 20 in 20.002 s | 7.9 ms | 13 delta, 40 unchanged | 0.76 MB |
| After | One viewer, 0.60–1.03 M | 20 in 20.001 s | 4.4 ms | 20 delta, 41 unchanged | 0.95 MB |
| Before | Two viewers, 1.04–1.80 M | 20 in 20.008 s | 12.4 ms | 20 snapshot, 29–33 unchanged | 63 MB |
| After | Two viewers, 1.03–1.62 M | 20 in 20.002 s | 9.2 ms | 20 delta, 40 unchanged | 0.88–0.95 MB |
| Before, late start | One viewer, 1.30–1.73 M | 20 in 20.003 s | 15.4 ms | 6 snapshot, 1 delta, 38 unchanged | 17.5 MB |
| After, late start | One viewer, 1.30–1.73 M | 20 in 20.002 s | 12.9 ms | 20 delta, 40 unchanged | 0.86 MB |
| Before, late start | Two viewers, 1.73–2.48 M | 20 in 20.009 s | 28.0 ms | 1 snapshot, 39–40 unchanged | 4.8 MB |
| After, late start | Two viewers, 1.73–2.49 M | 20 in 20.003 s | 21.4 ms | 20 delta, 38–39 unchanged | 0.87 MB |

Over whole 150 s turns after the fix: 138 and 137 recovery reads, reaching 2.98 M and 2.88 M characters. The renderer's round trip was p50 9–11 ms in the default run and 28–34 ms in the late run.

What this answers:

- **Task 1.** Every recovered transcript now reaches every reader as a delta, with one viewer or two, at every size measured (up to 2.49 M characters): about 0.9 MB per viewer in 20 s instead of 17.5–63 MB. With patches the grown head row travels as its appended text.
- **Task 2.** The view moves once per recovery (20 changes in 20 s per viewer) past 1.7 million characters, where it had moved once in 20 s.
- The one-second interval still holds: 20 recovery reads in 20 s, and a second reader adds none.
- The single-base bound (8 MiB) was not reached: a head row of about 4 million characters would reach it, and its readers would get snapshots again. That is a stated bound, not open work.

## Assumptions and decisions

### Task 1: keep the newest base instead of charging only dropped rows

The recommended option was to charge a superseded view only for the rows its successor dropped and let a grown row replace its predecessor. Implemented the second half as stated and kept the charge honest: a base is still charged for every row its successor does not share by object, because the old copy of a grown row is real memory. Instead, the per-key bound now sheds older bases but always keeps the newest one, so a grown row's base replaces the ring rather than emptying it, and a new single-base bound, `NATIVE_TRANSCRIPT_DELTA_MAX_BASE_BYTES` (8 MiB), keeps memory explicitly bounded; the 32 MiB total bound is unchanged. Raising the per-key bound was rejected as the to-do says: it moves the cliff and raises what every streaming session may hold. The delta's size was the open question in the recommended option's cons; the part-level patches clients already negotiate (`patchTranscriptDelta`) answer it once the base is kept, so no protocol change was needed.

### Task 2: compare what the view shows, not tokens

Implemented the recommended option. Each cached view carries a content sequence that moves only when its content does (a held preview, an `unchanged` answer and an artifact overlay keep it). A recovery records the sequence when its read starts and, if a newer revision has superseded it, commits only when the view still shows the same content and a newer recovery is still pending, so it never replaces a complete transcript that landed meanwhile. A superseded recovery that found nothing fuller leaves the retries to the newer one. Not chosen: dropping the held preview after a stale result, which would show the part-trimmed head (the start of the row cut off) while it streams.

### Task 2: no outcome counter

The Investigation suggested logging why each recovery ended, or reproducing it with the provider fake. The provider-fake test reproduces and pins the cause deterministically, and the loopback measurement shows the result, so no counter or log line was added.

### Task 3: after-fix runs only

Ran both recommended runs (default and `E10_READY_CHARS=1300000`) after the fix. The before figures are 6260's runs of the same scenario, unchanged code up to this fix, so they were not taken again on a host shared with nine other builds.

## Related

- 6260 task 3 (retired 2026-11-11): the measurements, `git show 1fd391e3a:docs/todo/transcripts-and-observation/6260-projection-hashing-measurements.md`.
- [native-transcripts.md, "Incomplete previews and exact recovery"](../../architecture/native-transcripts.md#incomplete-previews-and-exact-recovery).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): how often real sessions reach a part-trimmed head (6260 (retired) task 3).
