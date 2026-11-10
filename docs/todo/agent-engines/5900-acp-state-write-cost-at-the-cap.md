# ACP state write: is the cost at the cap real?

Carried from efficiency report batch E20 (`docs/reports/efficiency-logging-database/0240-e20-acp-bridge.md`, findings BR-1 and BR-12), deleted on 2026-11-05. Its original text is at `3baeaacf6`; its last version, ending with its outcome table, is the parent of the commit that deleted it (`git log --diff-filter=D -- <that path>`).

## Task analysis

Analysed 2026-11-05 against `main` at `3baeaacf6`.

### Tasks

2. **Repeat the write measurement on a quiet host**: the figures below were taken at load 28 to 53. Status: open.
3. **Decide on the fragment cache from those two answers**: Status: blocked (waits on 7568: 5900 task 1, and on task 2).

### 2. Repeat the write measurement on a quiet host

**Problem.** Load moved the figures by about a factor of two, so the cap-fits case sits either side of the 100 ms bar depending on what else was running.

**Context.** Other batches were running on the machine throughout. A single trial at load 13 gave 44 ms (a 14.7 MB version of cap-fits) and 105 ms (cap-over), against 84 to 112 ms and 178 to 195 ms at load 28 to 53.

**Investigation.** The script was not committed, as the ticket asked. It builds the fixture in the table below by filling `sessions` with `SessionState` objects, appends 4 KiB to one row per write, and times `persistedSnapshot()`, `JSON.stringify` plus `Buffer.byteLength`, and the mkdir, write and rename separately, over 25 writes after 5 warm-up writes, in a fresh process per run.

**Decisions.**

- **Where to run it?**
  - **The same machine with nothing else running, so the figures compare with the table (recommended).**
    - Pros: one variable changes.
    - Cons: says nothing about a slower host.
  - **A slower machine as well.**
    - Pros: shows the worst stall a user could see.
    - Cons: needs one to hand; not needed unless task 1 finds real large states.

### 3. Decide on the fragment cache from those two answers

**Problem.** The cache was not built because the measurement was not conclusive. It needs a decision once it is.

**Context.** The bar used for E20 was a median stall over 100 ms per write, a tenth of the interval, at sizes a real bridge holds. That bar was set after the first trial, not before it. Invariant 11 and the report's constraints apply to any cache: byte and count bounds, a crash loses at most one interval, `persistState()` barriers stay.

**Investigation.** Two things make the cache harder than the report's "by session revision".

- `state.revision` is not a complete dirty mark. `setPromptJournal` and `setStructuredResult` (`acp-public.ts`) do not move it, and `persistedSnapshot` itself clears `promptJournalComplete` when an entry falls off the budget. A cache keyed on it would write stale journal state, and the journal is what makes dispatch at-most-once. It would need a new dirty mark at every mutation site.
- A fragment depends on its neighbours: the structured, journal and config budgets run across sessions newest first, and `boundPersistedSnapshot` shares the transcript budget, so a change in one session's size can change another's allocation.

In the cap-over case most of the time is the per-session windowing in `boundPersistedSnapshot` (about 127 to 151 ms of 178 to 195 ms), which runs again on every write for every over-budget session. The floor a cache could reach was measured by encoding only the streaming session and joining the rest: 17 to 20 ms at the cap, ignoring budget accounting. File work (about 60 ms, asynchronous) does not change.

**Decisions.**

- **If tasks 1 and 2 show the cost is real, what first?**
  - **Remember each session's windowed result by its message revision, leaving the rest as it is (recommended).**
    - Pros: takes the largest single cost; the windowed messages depend only on the transcript and its allocation; no journal or config state goes through it, so a missed mark can only cost a longer transcript write.
    - Cons: helps only over-budget states; needs a bound on what it remembers.
  - **Cache each clean session's fragment, with a new dirty mark at every mutation site.**
    - Pros: the report's fix; approaches the floor above.
    - Cons: a missed mark writes stale state to disk, the worst failure for this file; budgets across sessions have to stay correct.
  - **Leave it.**
    - Pros: no risk to the state file.
    - Cons: a bridge at the bound stalls 100 to 200 ms per second while streaming.

## Current state

Measured on 2026-11-05 on an Intel Core Ultra 9 285H (16 CPUs, 62 GiB RAM, about 18 GiB available), Linux 7.1.8, Bun 1.4.4, state file on btrfs. Round 1 at `3baeaacf6`, load 28 to 46. Round 2 on the E20 bridge commit, load 45 to 53; of the code measured, that commit only removes a branch no session can reach. Each round is six fresh processes per fixture. Figures are the median across runs of each run's median write, in ms, with the lowest and highest run median in brackets.

| Fixture | Sessions | File | Sessions windowed | Stall, round 1 | Stall, round 2 | CPU | File work | Whole `writePersistedState` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | 8 | 1.2 MB | 0 | 6.7 [5.4-7.4] | 6.7 [4.6-13.2] | 4.4 | 6 | 14-16 |
| mid | 32 | 4.3 MB | 0 | 16.1 [13.0-20.1] | 17.1 [12.9-22.7] | 12 | 12-13 | 29-34 |
| cap-fits | 256 | 15.9 MB | 0 | 84.4 [83.3-107.6] | 111.6 [74.1-158.1] | 70-75 | 60-71 | 159-167 |
| cap-over | 256 | 16.4 MB | 256 | 177.7 [153.9-188.6] | 195.0 [143.1-322.9] | 149-151 | 61 | 233-358 |

"Stall" is the synchronous part: `persistedSnapshot()`, `JSON.stringify` and `Buffer.byteLength`. Single writes ranged from 47.5 to 379 ms for cap-fits and 107 to 499 ms for cap-over. cap-fits uses every budget (structured about 3 MB, journal about 0.7 MB, composer catalogue) with nothing trimmed; cap-over holds about 30 MB of transcript, so every session is windowed on every write.

## Constraints and rationale

- A crash can lose at most one interval of output.
- `persistState()` barriers stay.
- Report invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`): any cache needs byte and count bounds.

## Related

- to-do 1202 task 6 (retired 2026-11-10), BR-1 and BR-12
- Efficiency report, C (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 4) moved there on 2026-11-10.

## Replaces

Part `0240` and the frame-size question in part `0260` of the deleted batch file E20.
