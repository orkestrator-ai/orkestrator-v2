# Projection hashing: measurements left from E11

## Task analysis

Analysed 2026-11-05 against `main` at `39c26627f`, plus the E11 build. Re-checked 2026-11-05 against `main` at `e6c3da899`, when tasks 1 and 2 were done. The E11 batch file (efficiency report 0210) is deleted; read it as built from with `git show 39c26627f:docs/reports/efficiency-logging-database/0210-e11-projection-hashing.md`. Its outcome table, and the figures for tasks 1 and 2, are in the efficiency outcome report's closing check of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).

### Tasks

1. **Decide whether the small projection scans matter**: from part 0380, task 1. Status: done (2026-11-05): closed without a change; each scan is under 0.1% of a changed read. Figures in Measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).
2. **Measure what E11 saves on a changed read**: from the "Needs verification" of parts 0210, 0220, 0330 and 0350. Status: done (2026-11-05): 38–53% less CPU per changed progressive read. The legacy commit was 39% slower, which is now fixed. Figures in Measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); follow-ups 6860 and 6861 were done 2026-11-10 (legacy response left unspliced, preview fill check memoised; see "Response encoding" and "Incomplete previews and exact recovery" in [native-transcripts.md](../../architecture/native-transcripts.md)), with 7553 (retired 2026-11-11, done: the splice narrowed and now faster than `JSON.stringify`) as their follow-up, and 7755 (retired 2026-11-11, done: the legacy projection read is spliced too) after it.
3. **Whether one second suits a part-trimmed head while it streams**: from part 0320's "Needs verification". Count recovery reads per streaming turn and watch the view on a loopback-model `dev:test` profile with a scripted head row over 512 KiB. How often real sessions are in that state is on the manual-test checklist (7568: 6260 task 3). Status: done (2026-11-11): the interval holds at one recovery read a second per view, whatever the number of readers, and the view moves about once a second while the head row stays under about a million characters. Past that, readers get whole snapshots and then the view stalls, which is follow-up [7845](7845-trimmed-head-snapshots-and-stalled-view.md). Figures in Assumptions and decisions.

### 3. Whether one second suits a part-trimmed head while it streams

**Problem.** Part 0320 limited exact head-row recovery to one provider read a second per view (`PROGRESSIVE_HYDRATION_SETTLE_MS`). How often a session streams with a part-trimmed head (one row larger than the 512 KiB window) is unknown, so the saving is unmeasured, and the interval has not been seen on a real streaming turn.

**Context.** While a recovery is pending the view keeps showing the last recovered transcript (`holdPreview`), as it did while a read was in flight before. During continuous streaming the view of such a session therefore moves about once a second. The first recovery of a quiet view, a cached summary's included, still starts at once.

**Investigation.** Tested with fakes only ("head-row recovery" in `native-agent-service-projection-hashing.test.ts`) until 2026-11-11. Then measured on an isolated `dev:test` profile with the loopback-model spec's `trimmed-head` scenario: the profile's real Claude CLI streamed one response of 20 KB a second through the real bridge, backend and renderer, with no credentials and no billed turn. The figures are in Assumptions and decisions.

The changed-read benchmark written for tasks 1 and 2 (`scripts/benchmark-transcript-changed-read.ts`) does not answer this. It already counts the recovery reads its provider fake receives, so a part-trimmed scenario would show the one-second interval working at fake streaming rates. It cannot show how often real sessions are in that state. It makes the counter option's test cheap, but not the counter itself, which still needs a backend metric.

**Decisions.**

- **How to find out?**
  - **Count recovery reads per streaming turn on a scripted loopback-model turn whose head row is over 512 KiB, in an isolated `dev:test` profile (the loopback-model spec of [6680](6680-conditional-reads-and-deltas-measured.md) task 1), and watch the view (recommended).**
    - Pros: shows what a user sees through the profile's real renderer, backend and bridge, with no billed turn.
    - Cons: shows the interval working, not how often real sessions hit it; that rate needs a real long provider turn or real use (manual-test checklist, 7568: 6260 task 3).
  - **Add a content-free counter of recovery reads and of tokens that superseded a pending one.**
    - Pros: a lasting rate on any machine; the benchmark's provider fake could drive its test.
    - Cons: a new metric for a rare path.

## Current state

E11 is built, measured and profiled. Its changed progressive reads cost about half the CPU they did before. The legacy commit now fingerprints row fingerprints rather than every row's JSON, after the measurement showed it had become slower than before E11. The three small scans stay as they are. Task 3's loopback-model check is done; what it found on very large rows is follow-up 7845, and how often real sessions reach a part-trimmed head stays on the manual-test checklist.

## Assumptions and decisions

### Which commits were compared (task 2)

The to-do names `39c26627f` as the commit before E11. E11's merge (`fbb6c7560`) has `ea29f1709` as its parent, but on the measured path the two differ only by a debug log line, so `39c26627f` was used as written. "E11" in the figures is `main` with `fbb6c7560`'s `native-agent-projection-encoding.ts`. That is the only file this change edits on the path, and the rest of `main`'s projection differs from `fbb6c7560` only by debug log lines. The three trees ran interleaved, five rounds of 1,000 reads each, because this host's run-to-run noise (up to about 13%) was larger than the gaps between back-to-back runs.

### Fixing the legacy commit's regression (task 2)

The measurement showed `digestWithMessages` feeding every row's memoised JSON to SHA-256 (432,087 characters per changed read on a 431 KB window). That costs more than the whole-projection `JSON.stringify` comparison it replaced: 517 µs against 373 µs. It now feeds each row's memoised fingerprint (`updateHashWithFingerprints`), as the view token already did since 0220. A changed read hashes 15,943 characters and costs 281 µs. Leaving it for a follow-up would have kept a measured regression on `main`, and the change is two lines in one function with an existing primitive. The sync-v1 token is the function's only other caller. It is in-memory and equality-only, so its values change once at upgrade, costing each sync-v1 client one snapshot. That is the same cost 0220 accepted for the view token, so it needs no compatibility entry. Tests: "a digest with messages hashes a changed row once, not the window" (`native-agent-projection-encoding.test.ts`), and the legacy-commit test in `native-agent-service-projection-hashing.test.ts` now asserts that a changed read hashes less than the unchanged row's 4,000 characters. Both fail on the old function.

### Closing the scans without a change (task 1)

The to-do's rule was to fix a scan only if a profile showed it to be a meaningful share. None is: the largest, `displayedHead`, is 0.17–0.27 µs of a 240–453 µs profiled read. Even a worst-case full pass (no match in 100 rows) is under 1 µs. Comparing the first row's id directly, or building a map, would add code to a delicate function for no measurable gain, and a map built per read would cost more than the scan it replaces.

### Keeping the benchmark (tasks 1 and 2)

The benchmark is committed as `scripts/benchmark-transcript-changed-read.ts`, beside the other `benchmark-*.ts` scripts. It is outside every test run. It uses only APIs present before E11, so it can run on both commits for the next before-and-after. It needs no data directory other than a temporary one, starts no bridge, and makes no provider call.

### Measuring a part-trimmed head on a loopback model (task 3)

Measured 2026-11-11 on beelink2 (Linux) with the backend at `91cd5308e` and the spec as committed in `7cf11b9da` (the 90 s run predates its 150 s default), profile `e10-6680-measure`, started with `--no-agent-credentials --headless --agent-platforms claude` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`; stopped and reset afterwards. Command, per run: `ORKESTRATOR_AGENT_TEST_E10_BASELINE=1 E10_SCENARIO=trimmed-head mise run test:logged -- --name e10-trimmed -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts conditional-reads-live.spec.ts` (all passed). The response streams 2,000 characters every 100 ms. Measuring starts once 600,000 characters have streamed (1,300,000 in the third run, `E10_READY_CHARS`), then 20 s with one viewer and 20 s with a second page on the same tab. Every v2 snapshot in the measured windows was part-trimmed (`messageWindow.omittedParts`). "Recovery reads" are the bridge's `GET /session/:id/messages` requests.

| Run | Window (characters streamed) | Recovery reads | Bridge time per recovery read, mean | Renderer transcript answers per viewer | Renderer bytes per viewer |
| --- | --- | --- | --- | --- | --- |
| 90 s response | One viewer, 0.60–1.03 M | 20 in 20.016 s | 6.1 ms | 19 delta, 41 unchanged | 0.96 MB |
| 150 s response | One viewer, 0.60–1.04 M | 20 in 20.002 s | 7.9 ms | 13 delta, 40 unchanged | 0.76 MB |
| 150 s response | Two viewers, 1.04–1.80 M | 20 in 20.008 s | 12.4 ms | 20 snapshot, 29–33 unchanged | 63 MB |
| 150 s response, late start | One viewer, 1.30–1.73 M | 20 in 20.003 s | 15.4 ms | 6 snapshot, 1 delta, 38 unchanged | 17.5 MB |
| 150 s response, late start | Two viewers, 1.73–2.48 M | 20 in 20.009 s | 28.0 ms | 1 snapshot, 39–40 unchanged | 4.8 MB |

Over whole turns: 78 recovery reads in a 90.4 s turn and 136 and 138 in two 150 s turns, none before the head was first trimmed. The renderer's round trip stayed at a p50 of 16–48 ms.

What this answers:

- **The interval holds.** Exactly one recovery read a second, and a second reader adds none: recovery is per view key, not per page.
- **The view moves about once a second while the row is under about a million characters**, as the to-do expected. While a recovery is pending the view keeps the last recovered transcript, so the other answers are `unchanged`. The screenshot (`output/visual-previews/e10-trimmed-head-<run>.png`, git-ignored) showed the recovered row with "1580000 additional characters omitted from this rendered view" at 1.73 M streamed.
- **Past about a million characters, a recovered transcript reaches a reader as a whole snapshot** (about 3 MB each), with one viewer or two. The second-viewer and late-start runs separate the two causes: row size, not the second reader, decides it.
- **Past about 1.7 million characters, the view nearly stops**: one transcript change in 20 s per viewer although 20 recovery reads ran.

The last two are follow-up [7845](7845-trimmed-head-snapshots-and-stalled-view.md); its Investigation has the hypotheses. The one-second interval itself is not the cause in either, so it stays. How often real sessions reach this state is still the manual-test checklist's item.

### Not adding a recovery-read counter (task 3)

The decision's alternative was a content-free counter of recovery reads. The loopback scenario answers the interval question without one, and the open question (how often real sessions reach a part-trimmed head) is the user's checklist item, which already offers a counter as the alternative to a billed turn. So no counter was added here.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 3: how often a part-trimmed head streams on a real long provider turn) moved there on 2026-11-10.
- Efficiency outcome, closing check and measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)
- to-do 1202 efficiency follow-ups, tasks 1 and 5 (retired 2026-11-10)
- 6860 and 6861 (done 2026-11-10, deleted): costs the measurement found that E11 left; 7553 (retired 2026-11-11, done: the splice narrowed, figures in [native-transcripts.md](../../architecture/native-transcripts.md#response-encoding)) followed from them, and 7755 (retired 2026-11-11, done: the legacy projection read marked) from that
- [5340](5340-transcript-reads-live-evidence.md): E9's live evidence, which a live run for task 3 can collect too
- [7845](7845-trimmed-head-snapshots-and-stalled-view.md): the whole snapshots and stalled view task 3 found on rows over about a million characters
