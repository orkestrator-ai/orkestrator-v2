# Projection hashing: measurements left from E11

## Task analysis

Analysed 2026-11-05 against `main` at `39c26627f`, plus the E11 build. The E11 batch file (efficiency report 0210) is deleted; read it as built from with `git show 39c26627f:docs/reports/efficiency-logging-database/0210-e11-projection-hashing.md`. Its outcome table is kept in the efficiency index's closing check of E11.

### Tasks

1. **Decide whether the small projection scans matter**: profile a changed read, then fix or close. From part 0380, task 1. Status: open.
2. **Measure what E11 saves on a changed read**: before-and-after figures for the serialising and hashing E11 removed. From the "Needs verification" of parts 0210, 0220, 0330 and 0350. Status: open.
3. **How often a part-trimmed head streams, and whether one second suits it**: from part 0320's "Needs verification". Status: open.

### 1. Decide whether the small projection scans matter

**Problem.** A few one-off linear scans run per projection. The report names the sites but no fix, and recommends leaving them unless a profile of a changed read shows them. E11 took no profile, so the item is still undecided.

**Context.** Each scan is one pass over a bounded window (at most 100 rows), and small beside the serialising and hashing in the same read, much of which E11 removed. That makes the scans a larger share of what is left, which is a reason to profile after E11 rather than before.

**Investigation.** Re-checked on 2026-11-05 against `39c26627f`; all three remain in `apps/backend/src/core/native-agent-transcript-projection.ts` (line numbers after the E11 build): `firstUserMessageIndex` in `projectionMessages` (`:1267`), which usually stops early; the head-row lookup in `fillIncompleteProgressiveSnapshot` (`recoveredHead`, `:2176`), which runs only on a recovery read; and the one in `projectProgressiveTranscript` (`displayedHead`, `:2219`), which runs on every changed read.

**Decisions.**

- **Change them?**
  - **Leave them unless a profile of a changed read shows them (recommended).**
    - Pros: no code for a cost nobody has seen; a map per read may cost more than the scan it replaces.
    - Cons: the item stays open until someone profiles a read.
  - **Replace the two head lookups with the first row's id compared directly, or a map.**
    - Pros: removes the scans.
    - Cons: more code in a delicate function.

### 2. Measure what E11 saves on a changed read

**Problem.** Every E11 part was reasoned, not measured: the legacy commit's fingerprint (0210), the view token over row fingerprints (0220), patch building from memoised encodings (0330), and memoised inline tool bodies (0350). Nobody has the before-and-after cost of a changed read.

**Context.** E11 is built with focused tests that count serialisations and hashed characters rather than time: `native-agent-projection-encoding.test.ts` (fingerprints, measures, splicing), `native-agent-service-projection-hashing.test.ts` (legacy commit, view token, recovery, tool bodies), `packages/protocol/src/native-agent-transcript-patch.test.ts` (parts digest) and `native-agent-display-tails.test.ts` (one payload). The method for figures is [1202 task 1](../cross-cutting/1202-efficiency-review-follow-ups.md)'s: the same measurement on two commits.

**Investigation.** Not measured. A fixture is enough for CPU per changed read; no provider turn is needed. A streaming row with many inline tool parts (OpenCode, or a raw `transcriptSnapshot`) shows 0350's case, and a session with `revisedMessages` shows 0340's.

**Decisions.**

- **How to measure it?**
  - **Profile a changed read on a provider fake, on `39c26627f` and on the E11 merge, in the same run as task 1 (recommended).**
    - Pros: no billed turn; one run answers this task and task 1; repeatable.
    - Cons: a fake's row shapes are not a real session's.
  - **Measure on a real session in an isolated `dev:test` profile.**
    - Pros: real row shapes and sizes.
    - Cons: needs a real provider turn, which is billed.

### 3. How often a part-trimmed head streams, and whether one second suits it

**Problem.** Part 0320 limited exact head-row recovery to one provider read a second per view (`PROGRESSIVE_HYDRATION_SETTLE_MS`). How often a session streams with a part-trimmed head (one row larger than the 512 KiB window) is unknown, so the saving is unmeasured, and the interval has not been seen on a real streaming turn.

**Context.** While a recovery is pending the view keeps showing the last recovered transcript (`holdPreview`), as it did while a read was in flight before. During continuous streaming the view of such a session therefore moves about once a second. The first recovery of a quiet view, a cached summary's included, still starts at once.

**Investigation.** Tested with fakes only ("head-row recovery" in `native-agent-service-projection-hashing.test.ts`). No real session with a part-trimmed head was observed.

**Decisions.**

- **How to find out?**
  - **Count recovery reads per streaming turn on a long Codex turn in an isolated `dev:test` profile, and watch the view (recommended).**
    - Pros: shows both the rate and what a user sees.
    - Cons: needs a real provider turn that produces a head row over 512 KiB.
  - **Add a content-free counter of recovery reads and of tokens that superseded a pending one.**
    - Pros: a lasting rate on any machine.
    - Cons: a new metric for a rare path.

## Current state

E11 is built: the legacy commit and the view token hash memoised row encodings, head-row recovery reads at most once a second, patch digests and gateway responses reuse memoised encodings, restart-preview checkpoints are serialised once for size and row and handed out frozen, and inline tool bodies are memoised per part. Only the profile and the measurements above are left.

## Related

- [Efficiency index, closing check of E11](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e11-projection-hashing)
- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 5
- [Efficiency report, B](../../reports/2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-3, TX-7, TX-9, TX-11 to TX-14, TX-16, TX-17)
- [5340](5340-transcript-reads-live-evidence.md): E9's live evidence, which the same profile run can collect
