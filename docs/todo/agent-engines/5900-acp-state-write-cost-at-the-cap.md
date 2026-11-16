# ACP state write: is the cost at the cap real?

Carried from efficiency report batch E20 (`docs/reports/efficiency-logging-database/0240-e20-acp-bridge.md`, findings BR-1 and BR-12), deleted on 2026-11-05. Its original text is at `3baeaacf6`; its last version, ending with its outcome table, is the parent of the commit that deleted it (`git log --diff-filter=D -- <that path>`).

## Task analysis

Analysed 2026-11-16 against `main` at `c1fcc573b` (first analysed 2026-11-05 at `3baeaacf6`).

### Tasks

2. **Repeat the write measurement on a quiet host**: the first figures were taken at load 28 to 53. Status: done (2026-11-16, load 2.7 to 3.8; see [Current state](#current-state)).
3. **Decide on the fragment cache from those two answers**: Status: blocked (waits on 7568: 5900 task 1, real state sizes; task 2's answer is in).

### 2. Repeat the write measurement on a quiet host

**Problem.** Load moved the figures by about a factor of two, so the cap-fits case sat either side of the 100 ms bar depending on what else was running.

**Context.** Other batches were running on the machine throughout the first measurement. A single trial at load 13 gave 44 ms (a 14.7 MB version of cap-fits) and 105 ms (cap-over), against 84 to 112 ms and 178 to 195 ms at load 28 to 53.

**Investigation.** Done on 2026-11-16 on the same machine, at load 2.7 to 3.8 (one-minute load average, read by each run). The E20 script was never committed, so the fixture was rebuilt from the description: same session counts, same file sizes, the same structured (about 3 MB), journal (about 0.7 MB) and composer-catalogue budgets, the same 4 KiB append to the streaming session's text part per write, 5 warm-up writes then 25 timed, six fresh processes per fixture. The first trial showed that the *content* of the transcript moves the cost as much as load did: plain ASCII text serialises about three times faster than code-like text with escapes and non-ASCII characters, and splitting a 4 KiB message into 16 parts instead of 2 costs more again. So every fixture was run in four shapes and the fixtures are sized by serialised bytes, not by characters. The full table is in [Current state](#current-state).

Answer: on a quiet host the stall at the bound is about half the loaded figure.

- **cap-fits** (256 sessions, 16.0 MB, nothing windowed): 22 to 44 ms median stall across the four shapes, at most 47 ms for any run's median. Nowhere near the 100 ms bar.
- **cap-over** (256 sessions, every one windowed): 40 to 108 ms. Only the code-like, 2-part shape crosses the bar (107.5 ms, runs 105.5 to 110.7). Windowing is still the largest part: `persistedSnapshot`, which does it, takes 59 to 80 ms of 79 to 108 ms in the two slower shapes, against 15 to 22 ms in cap-fits, where nothing is windowed.
- The code-like, 2-part shape gives 44.0 ms and 107.5 ms, the same as the single load-13 trial (44 and 105 ms), so it is probably the closest to the lost E20 fixture.
- At plausible sizes (8 or 32 sessions, 1.3 or 4.4 MB) a write stalls 1 to 9 ms.

**Decisions.**

- **Where to run it?**
  - **The same machine with nothing else running, so the figures compare with the table (recommended, done).**
    - Pros: one variable changes.
    - Cons: says nothing about a slower host.
  - **A slower machine as well.**
    - Pros: shows the worst stall a user could see.
    - Cons: needs one to hand; not needed unless task 1 finds real large states.

### 3. Decide on the fragment cache from those two answers

**Problem.** The cache was not built because the measurement was not conclusive. It needs a decision once it is.

**Context.** The bar used for E20 was a median stall over 100 ms per write, a tenth of the interval, at sizes a real bridge holds. That bar was set after the first trial, not before it. Task 2 answered its half on 2026-11-16: on a quiet host only cap-over, every one of 256 sessions over its transcript share, reaches the bar, and only with code-like content (107.5 ms); cap-fits stays at 22 to 44 ms. So the decision now turns on task 1 alone: whether a real bridge holds a state near 16 MB with many sessions over their transcript share. Only the all-sessions case was measured; a state between cap-fits and cap-over costs somewhere between the two. Invariant 11 and the report's constraints apply to any cache: byte and count bounds, a crash loses at most one interval, `persistState()` barriers stay.

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
    - Cons: a bridge at the bound stalls 40 to 110 ms per second while streaming on a quiet host (task 2), about twice that on a loaded one.

## Current state

### Round 3: quiet host (2026-11-16)

Same machine (about 48 GiB RAM available this time), Linux 7.1.8, Bun 1.4.4, state file on btrfs, at `c1fcc573b`, load 2.7 to 3.8. Six fresh processes per fixture and shape, 5 warm-up and 25 timed writes each. Figures are the median across runs of each run's median write, in ms, with the lowest and highest run median in brackets; the other columns are medians of run medians.

The fixture fills `sessions` with `SessionState` objects whose transcripts are sized by serialised bytes: small and mid aim at 145 and 130 KB of transcript per session; cap-fits fills each session to bring the file to 15.9 MB with nothing windowed; cap-over holds 117 KB per session (about 30 MB in all). cap-fits and cap-over also carry two 6 KiB structured results (about 3 MB), 30 completed journal entries (about 0.7 MB) and a 24-model composer catalogue per session. Messages are 4 KiB: every fourth a user prompt, the rest an assistant row of text and `read_file` tool parts. Each write appends 4 KiB to the streaming (last) session's newest text part. Shapes: *plain* is repeated ASCII words; *code* is source-like lines with quotes, backslashes, tabs, newlines, accented and CJK characters; *2 parts* or *16 parts* is how many parts a 4 KiB assistant message is split into. The script stayed out of the repository, as in E20.

| Shape | Fixture | File | Windowed | Stall | `persistedSnapshot` | stringify | File work | Whole `writePersistedState` | Single-write stall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plain, 2 parts | small | 1.3 MB | 0 | 0.9 [0.8-0.9] | 0.3 | 0.4 | 1.4 | 2.3 | 0.5-3.4 |
| plain, 2 parts | mid | 4.4 MB | 0 | 4.1 [3.8-4.4] | 1.6 | 2.3 | 3.5 | 7.9 | 2.9-8.0 |
| plain, 2 parts | cap-fits | 16.0 MB | 0 | 22.1 [21.8-24.0] | 9.7 | 12.6 | 12.7 | 34.8 | 16.7-35.2 |
| plain, 2 parts | cap-over | 16.6 MB | 256 | 39.6 [38.5-40.8] | 26.4 | 13.0 | 12.8 | 53.8 | 33.8-64.6 |
| plain, 16 parts | small | 1.3 MB | 0 | 1.4 [1.3-1.5] | 0.6 | 0.7 | 1.5 | 3.0 | 0.9-4.3 |
| plain, 16 parts | mid | 4.3 MB | 0 | 7.0 [6.7-7.1] | 3.3 | 3.6 | 3.3 | 10.6 | 5.8-11.1 |
| plain, 16 parts | cap-fits | 15.9 MB | 0 | 32.4 [31.8-35.8] | 15.0 | 17.2 | 12.3 | 44.6 | 26.2-66.6 |
| plain, 16 parts | cap-over | 15.8 MB | 256 | 79.1 [76.9-89.2] | 59.2 | 20.3 | 12.7 | 92.5 | 66.2-113.7 |
| code, 2 parts | small | 1.3 MB | 0 | 2.6 [2.3-2.9] | 1.2 | 1.3 | 1.7 | 4.6 | 2.1-7.2 |
| code, 2 parts | mid | 4.4 MB | 0 | 9.1 [8.4-11.4] | 3.9 | 5.1 | 3.9 | 13.8 | 7.5-18.5 |
| code, 2 parts | cap-fits | 16.0 MB | 0 | 44.0 [42.2-46.6] | 22.2 | 21.9 | 18.8 | 62.4 | 37.1-91.0 |
| code, 2 parts | cap-over | 15.9 MB | 256 | 107.5 [105.5-110.7] | 80.2 | 27.5 | 18.8 | 126.3 | 81.5-154.6 |
| code, 16 parts | small | 1.3 MB | 0 | 2.3 [2.2-3.0] | 1.1 | 1.2 | 1.7 | 4.3 | 2.1-7.4 |
| code, 16 parts | mid | 4.4 MB | 0 | 8.6 [8.1-9.6] | 3.6 | 4.7 | 4.1 | 13.1 | 7.1-18.4 |
| code, 16 parts | cap-fits | 16.0 MB | 0 | 41.1 [40.1-47.0] | 21.9 | 18.9 | 18.4 | 61.5 | 36.0-63.8 |
| code, 16 parts | cap-over | 15.7 MB | 256 | 90.4 [87.4-98.9] | 62.9 | 28.1 | 16.2 | 109.5 | 77.3-159.7 |

"stringify" is `JSON.stringify` plus `Buffer.byteLength`; "File work" is the asynchronous mkdir, write and rename. cap-over's file size varies by shape because windowing keeps whole messages.

### Rounds 1 and 2: loaded host (2026-11-05)

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

## Assumptions and decisions

### Task 2: rebuilding the fixture (2026-11-16)

- **Chose:** a fixture rebuilt from the to-do's description and sized by serialised bytes, run in four content shapes rather than one. The E20 script was not committed, and its message content was not recorded. The first trial showed content alone moves the stall about threefold (plain ASCII against code-like text), so a single guessed shape could not be compared with rounds 1 and 2. The code-like, 2-part shape reproduces the earlier load-13 trial (44 and 105 ms against 44.0 and 107.5 ms), which is the closest available check that it resembles the E20 fixture.
- **Chose:** not committing the script, as E20 did. A committed benchmark needs a test, typechecking and upkeep for a Low finding; the fixture is described in [Current state](#current-state) closely enough to rebuild. If task 3 builds a cache, commit a benchmark with it so the before and after compare like for like.

### Task 2: what counts as quiet (2026-11-16)

- **Chose:** the load the host had when this pipeline ran: 2.7 to 3.8 on the 16-CPU machine during the formal runs (0.9 to 4.2 during the trial runs before them), recorded by each run. The pipeline's own session was running and other processes on the host were not controlled, so load 0 was not reachable. Rounds 1 and 2 were at 28 to 53, so the comparison the task asked for, a quiet host against a loaded one, holds.

## Related

- to-do 1202 task 6 (retired 2026-11-10), BR-1 and BR-12
- Efficiency report, C (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 4) moved there on 2026-11-10.

## Replaces

Part `0240` and the frame-size question in part `0260` of the deleted batch file E20.
