# Projection hashing: measurements left from E11

## Task analysis

Analysed 2026-11-05 against `main` at `39c26627f`, plus the E11 build. Re-checked 2026-11-05 against `main` at `e6c3da899`, when tasks 1 and 2 were done. The E11 batch file (efficiency report 0210) is deleted; read it as built from with `git show 39c26627f:docs/reports/efficiency-logging-database/0210-e11-projection-hashing.md`. Its outcome table, and the figures for tasks 1 and 2, are in the efficiency outcome report's closing check of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).

### Tasks

1. **Decide whether the small projection scans matter**: from part 0380, task 1. Status: done (2026-11-05): closed without a change; each scan is under 0.1% of a changed read. Figures in Measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).
2. **Measure what E11 saves on a changed read**: from the "Needs verification" of parts 0210, 0220, 0330 and 0350. Status: done (2026-11-05): 38–53% less CPU per changed progressive read. The legacy commit was 39% slower, which is now fixed. Figures in Measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`); follow-ups 6860 and 6861 were done 2026-11-10 (legacy response left unspliced, preview fill check memoised; see "Response encoding" and "Incomplete previews and exact recovery" in [native-transcripts.md](../../architecture/native-transcripts.md)), with [7551](7551-transcript-splice-slower-on-large-rows.md) as their follow-up.
3. **How often a part-trimmed head streams, and whether one second suits it**: from part 0320's "Needs verification". Status: open.

### 3. How often a part-trimmed head streams, and whether one second suits it

**Problem.** Part 0320 limited exact head-row recovery to one provider read a second per view (`PROGRESSIVE_HYDRATION_SETTLE_MS`). How often a session streams with a part-trimmed head (one row larger than the 512 KiB window) is unknown, so the saving is unmeasured, and the interval has not been seen on a real streaming turn.

**Context.** While a recovery is pending the view keeps showing the last recovered transcript (`holdPreview`), as it did while a read was in flight before. During continuous streaming the view of such a session therefore moves about once a second. The first recovery of a quiet view, a cached summary's included, still starts at once.

**Investigation.** Tested with fakes only ("head-row recovery" in `native-agent-service-projection-hashing.test.ts`). No real session with a part-trimmed head was observed. Re-checked 2026-11-05: the answer needs a real provider turn whose head row is over 512 KiB, which a build without billed turns cannot run, so the decision below is unchanged.

The changed-read benchmark written for tasks 1 and 2 (`scripts/benchmark-transcript-changed-read.ts`) does not answer this. It already counts the recovery reads its provider fake receives, so a part-trimmed scenario would show the one-second interval working at fake streaming rates. It cannot show how often real sessions are in that state. It makes the counter option's test cheap, but not the counter itself, which still needs a backend metric.

**Decisions.**

- **How to find out?**
  - **Count recovery reads per streaming turn on a long Codex turn in an isolated `dev:test` profile, and watch the view (recommended).**
    - Pros: shows both the rate and what a user sees.
    - Cons: needs a real provider turn that produces a head row over 512 KiB.
  - **Add a content-free counter of recovery reads and of tokens that superseded a pending one.**
    - Pros: a lasting rate on any machine; the benchmark's provider fake could drive its test.
    - Cons: a new metric for a rare path.

## Current state

E11 is built, measured and profiled. Its changed progressive reads cost about half the CPU they did before. The legacy commit now fingerprints row fingerprints rather than every row's JSON, after the measurement showed it had become slower than before E11. The three small scans stay as they are. Only task 3 is left.

## Assumptions and decisions

### Which commits were compared (task 2)

The to-do names `39c26627f` as the commit before E11. E11's merge (`fbb6c7560`) has `ea29f1709` as its parent, but on the measured path the two differ only by a debug log line, so `39c26627f` was used as written. "E11" in the figures is `main` with `fbb6c7560`'s `native-agent-projection-encoding.ts`. That is the only file this change edits on the path, and the rest of `main`'s projection differs from `fbb6c7560` only by debug log lines. The three trees ran interleaved, five rounds of 1,000 reads each, because this host's run-to-run noise (up to about 13%) was larger than the gaps between back-to-back runs.

### Fixing the legacy commit's regression (task 2)

The measurement showed `digestWithMessages` feeding every row's memoised JSON to SHA-256 (432,087 characters per changed read on a 431 KB window). That costs more than the whole-projection `JSON.stringify` comparison it replaced: 517 µs against 373 µs. It now feeds each row's memoised fingerprint (`updateHashWithFingerprints`), as the view token already did since 0220. A changed read hashes 15,943 characters and costs 281 µs. Leaving it for a follow-up would have kept a measured regression on `main`, and the change is two lines in one function with an existing primitive. The sync-v1 token is the function's only other caller. It is in-memory and equality-only, so its values change once at upgrade, costing each sync-v1 client one snapshot. That is the same cost 0220 accepted for the view token, so it needs no compatibility entry. Tests: "a digest with messages hashes a changed row once, not the window" (`native-agent-projection-encoding.test.ts`), and the legacy-commit test in `native-agent-service-projection-hashing.test.ts` now asserts that a changed read hashes less than the unchanged row's 4,000 characters. Both fail on the old function.

### Closing the scans without a change (task 1)

The to-do's rule was to fix a scan only if a profile showed it to be a meaningful share. None is: the largest, `displayedHead`, is 0.17–0.27 µs of a 240–453 µs profiled read. Even a worst-case full pass (no match in 100 rows) is under 1 µs. Comparing the first row's id directly, or building a map, would add code to a delicate function for no measurable gain, and a map built per read would cost more than the scan it replaces.

### Keeping the benchmark (tasks 1 and 2)

The benchmark is committed as `scripts/benchmark-transcript-changed-read.ts`, beside the other `benchmark-*.ts` scripts. It is outside every test run. It uses only APIs present before E11, so it can run on both commits for the next before-and-after. It needs no data directory other than a temporary one, starts no bridge, and makes no provider call.

## Related

- Efficiency outcome, closing check and measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 5
- 6860 and 6861 (done 2026-11-10, deleted): costs the measurement found that E11 left; [7551](7551-transcript-splice-slower-on-large-rows.md) followed from them
- [5340](5340-transcript-reads-live-evidence.md): E9's live evidence, which a live run for task 3 can collect too
