# Backend event-loop stalls grew over a long busy soak

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (first analysed 2026-11-10
at `c98b20e6f`). Written from the 4960 busy soak of 2026-11-10 ([Change tracking: busy live
soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)),
which measured the change-tracking row cap and saw this on the side.

### Tasks

1. **Find what makes the stalls grow over a long busy run**: reproduce the growth and attribute it. Status: done (2026-11-11: the event-loop thread waits on disk inside bursts of short main-database SQLite calls that grow with the run; see Assumptions and decisions).
2. **Decide the fix once the cause is known**. Status: open.

### 1. Find what makes the stalls grow over a long busy run

**Problem.** On the 97-minute busy soak the backend's event-loop stall log
(`[event-loop] stalled`, [logging](../../architecture/logging.md)) reported
106 stalls with a p50 of 3.8 s and a maximum of 11.6 s. They grew over the
run rather than tracking the load: the longest stall was 1.3 s in the first
10 minutes, 2.4 to 4.1 s from 09:50 to 10:29, 5.4 s from 10:30, and 11.2 to
11.6 s in every 10-minute window from 10:40 to the end. A stall of that length
delays every command, poll and SSE frame the backend serves.

**Context.** The run: `scripts/recurring-live-ab.ts --busy-rounds 50
--busy-clients 0,1,2 --busy-environments 10 --busy-burst-files 2500
--busy-turn-files 2500` on a headless `dev:test` profile on beelink (16
cores), loopback fake model, 150 rounds and 443 turns. Each round wrote and
removed 2,500 files in each of 10 worktrees and wrote 2,500 more inside the
held turn. Backend RSS had a median of 429 MiB and a maximum of 751 MiB over
the busy window. The host's load average was 50 to 64 for most of the run,
partly from the run itself, and the stalls appear with
`commandsInFlight` of 0 to 7, so host load explains part of their length but
not their steady growth. `start_local_pi_server_cmd` was the most frequent
slow command (34 `command.slow` lines).

**Investigation.** Not attributed. Things that grew during the run and are
worth separating, none of them measured as a cause:

- The change-tracking ledger, from 41 MiB at 11 minutes to a 151 MiB peak
  (555,456 file rows), then 92 MiB after the hourly pass and 134 MiB at the
  end. Its stall did not fall after the pass shrank it, which argues against
  it.
- One Pi session in `busy-1` took two turns per round (about 295 turns), so its
  transcript grew for the whole run; native activity sweeps and live updates
  read it.
- Recursive worktree watches on Linux: every round created and removed a
  2,500-file directory in 11 worktrees
  ([7560](7560-large-ignored-trees-in-the-worktree-watch.md) is the related
  walk cost of a large tree).

A run that keeps the workload but turns one of these off (no held-turn files;
a fresh session every N rounds; smaller bursts), with the backend's CPU
profile captured around a long stall, would separate them.

**Decisions.**

- **How to attribute it?**
  - **A/B soaks of the same driver with one growth source removed, plus a CPU profile at a long stall (recommended).**
    - Pros: uses the existing busy driver and stall log; each arm names or clears one suspect.
    - Cons: each arm is a run of over an hour on a host whose load also varies.
  - **Instrument the suspects (transcript size, ledger query time, watch count) in `/metrics` first.**
    - Pros: one run then shows all of them over time.
    - Cons: new product surface before the cause is known.

### 2. Decide the fix once the cause is known

**Problem.** Task 1 found that the stalls are the event-loop thread blocked on
disk inside bursts of short SQLite calls on the main database
(`orkestrator.sqlite`): 850 to 2,175 calls in a stall, more as the run went
on, on a btrfs home directory, while the busy workload writes and removes
tens of thousands of worktree files a round.
Which caller issues a burst, and which of its calls commit (each commit of
the main database syncs its WAL, `synchronous = FULL`), is not yet known.

**Context.** [0741](0741-backend-responsiveness-under-load.md) owns load
qualification with the stall log; this file is one observation for it.
`bun:sqlite` runs on the event-loop thread, so every call's disk wait is a
stall. The main database stays FULL on purpose
([storage](../../architecture/storage.md), durability), and the ledger
already runs NORMAL. A stall line now carries `storageCalls`,
`storageCallMs`, `storageMainCallMs` and `storageLedgerCallMs` (every call in
its window, [logging](../../architecture/logging.md)), but not which store or
job made them.

**Investigation.** One lead, measured but not yet proved by an A/B run: the
public CLI's operation namespace. The busy driver does all its work through
the `orkestrator` CLI, and every `public_action` update loads the whole
namespace document (`public-operations/ns-…`, a document-mode store), checks
every record (`loadNamespaceRecords`, a SHA-256 request key per record) and
writes the whole document back (`saveNamespaceRecords`, one FULL-synced
commit) (`apps/backend/src/core/storage-public-operations.ts`). A namespace takes
admissions for seven days, up to 5,000 records or 16 MiB
(`PUBLIC_OPERATION_RETENTION`), so its cost per update grows with every
operation in that window. In the instrumented run it held 319 records in
395 KB at round 44, rewritten about 41 times a minute (seven new records a
minute), and 452 records in 560 KB at round 62, rewritten 35 times a minute:
16 and then 19.6 MiB a minute of WAL, and the same again when checkpointed.
The backend wrote 31 and then 100 MiB a minute to disk in those minutes
(`/proc/<pid>/io` `write_bytes`; change-tracking captures of the bulk turns
write too), so the namespace was most of the first minute's writes and about
two fifths of the second's. That fits both halves of the growth: more JSON
and hashing on the thread each update, and more bytes to sync. It does not explain the size of a
burst (each load or save is one SQLite call), so the second step is naming the
burst: per store family (and read against write) call counts in the stall
window, from the instrumentation's existing `store` naming. The busy window's
recurring metrics put most store calls in `native-activity-sweep` (about
3,300 reads, 440 writes and 440 stats a minute in the 150-round run), then
`multi-review-tick` and `mail-presence`.

**Decisions.**

- **Where should the fix live?**
  - **In the callers whose cost grows: store public operation records one row each instead of one document per namespace, then batch the burst's caller into one transaction per pass (recommended).**
    - Pros: fixes the cause; a row write costs the same at the 5,000th record as at the first; one commit is one WAL sync instead of hundreds; keeps the main database's durability; the new stall fields show the effect directly.
    - Cons: the namespace layout is part of the public CLI contract (admit before acting, under its lock; [public CLI](../../architecture/public-cli.md)), so the row layout needs a migration and that contract's tests; the burst's caller must be named first, and its writes must be safe to commit together.
  - **Move main-database writes off the event-loop thread (a worker connection).**
    - Pros: no SQLite disk wait can stall the loop whatever the caller.
    - Cons: a large change to `StorageService`'s synchronous `updateStore` contract and its lease rules; hides a caller whose work keeps growing.
  - **Run the main database at `synchronous = NORMAL`, as the ledger does.**
    - Pros: one line; removes the per-commit WAL sync.
    - Cons: gives up power-loss durability that `storage.md` keeps on purpose; reads waiting on writeback still stall; a decision for the maintainer, not a fix for a growing caller.
  - **A general yield or budget in the busiest recurring loops.**
    - Pros: bounds any single stall whatever its cause.
    - Cons: hides a growth that would come back elsewhere.

## Assumptions and decisions

### Task 1: reproduced at normal load, then split by where the profile lives

Followed the recommended option (A/B runs of the same driver, one growth
source removed), with two departures, both forced by the host. No CPU profile
was taken: an agent-test backend gets an allowlisted environment, so
`BUN_OPTIONS=--cpu-prof` never reaches it, and Bun writes such a profile only
at exit. Instead a sampler read the backend's main thread from `/proc` every
50 ms (state and wait channel; per-thread CPU), which names where the thread
waits without restarting it. And the arms change where the profile's files
live rather than the workload, because the first sample showed the thread
waiting on disk.

All runs on 2026-11-11 on beelink2 (Linux 7.2.15, 16 cores, `/home` on
btrfs; a host shared with other builds, load average 1 to 53 over the
morning, 5 to 9 for the second half of the first run), headless `dev:test`
profiles of one local fixture environment, only the Pi toolchain, no
credentials, the reachability check off, every model call on the driver's
loopback fake model, `--keep-profiles` so the logs could be read, each profile
reset afterwards:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 30000 --window-ms 30000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --busy-rounds 50 \
  --busy-clients 0,1,2 --busy-environments 10 --busy-burst-files 2500 \
  --busy-turn-files 2500 --keep-profiles --profile-prefix q7562r1
# arms: --busy-clients 0,1 (100 rounds) with XDG_CONFIG_HOME pointing the whole
# development root (profile data and fixture worktrees) at /dev/shm (tmpfs) or
# at a btrfs directory with copy-on-write off (chattr +C); the two ran together.
```

| Run | Build | Rounds | Stall lines (rate-limited) | Longest stall | Activity indicator p95 (≤ 4 s) | Queued prompt dispatch p95 (≤ 3 s) |
| --- | --- | --- | --- | --- | --- | --- |
| R1, default (btrfs) | `83731af28` | 150 (0, 1, 2 clients), 104 min | 110 | 13.1 s | 11.4 s | 10.7 s |
| Arm, btrfs with copy-on-write off | `88c1cb15b` | 100 (0, 1 clients), 38 min | 50 | 6.5 s | 6.1 s | 6.4 s |
| Arm, tmpfs | `88c1cb15b` | 100 (0, 1 clients), 38 min | 0 | under 1 s | 2.5 s | 2.5 s |

What that shows:

- **The growth appears at a normal load.** In R1 the 10-minute windows went
  from no stall (first 25 minutes) to a median stall of 1.5 s, 2.2, 4.2, 4.6,
  5.3, 6.8, 7.5 and 10.2 s, the last four at a load average of 8 to 9 and
  then 34. Host load is not the cause.
- **Not the client count.** The stalls grew inside each phase of constant
  clients (1 client: 2.2 to 4.6 s; 2 clients: 5.3 to 10.2 s).
- **The thread waits on disk.** Over two 60 s samples in R1 the main thread
  was in uninterruptible sleep 27% and 31% of the time, in btrfs writeback and
  sync waits (`folio_wait_bit` 12 to 14%, `write_all_supers` 9 to 11%,
  `__folio_lock`, `wait_log_commit`), with stretches of 5.6 and 8.7 s off the
  idle poll. The process's CPU in a stall (`cpuMs`) was 35 to 52% of it, and
  that share held while the stalls grew, so the work and the waiting grew
  together. The allocator's scavenger and the garbage collector's helper
  threads each used about a tenth of the main thread's CPU.
- **Not the filesystem as a whole.** A probe that wrote and synced 4 KiB in a
  fresh file in the same worktree every 250 ms during R1 saw fsync at 3.7 ms
  median and 9.9 ms at most.
- **Not copy-on-write fragmentation**, though the ledger fragmented badly in
  R1 (27,006 extents for 146 MiB): with copy-on-write off it stayed at 44
  extents and the stalls still grew, 1.4 to 4.4 s median over 38 minutes, with
  the thread in the same waits (15% of a sample).
- **The disk is the cause.** On tmpfs the same 100 rounds had no stall line;
  the main thread used as much CPU as the btrfs arm's (1,369 against 1,263
  ticks a minute) but never waited on the disk, its longest busy stretch was
  under a second, and the two client budgets R1 missed were met.
- **Main-database SQLite, in many short calls.** No stall line in R1 named a
  storage operation, because the stall context listed only calls of 250 ms or
  more. Stall lines now also count every call in their window
  (`storageCalls`, `storageCallMs`, `storageMainCallMs`,
  `storageLedgerCallMs`; [logging](../../architecture/logging.md)). A
  fourth run with them (`dc811586a`, 70 rounds without clients on the default
  btrfs root, `--profile-prefix q7562calls`, a nearly idle host at a load
  average of 1 to 3) had fewer and shorter stalls (1.0 to 2.8 s: other
  builds' disk traffic lengthens the waits, and 66 of its 70 rounds idled
  60 s on the driver's burst rescan wait, a driver mismatch since fixed: to-do
  7765 (retired 2026-11-11; [testing guide](../../development/testing-guide.md#live-idle-ab))), but every stall line counted
  SQLite calls on the main database covering the whole stall
  (`storageMainCallMs` 1,096 to 2,951 ms for stalls of 1,049 to 2,844 ms;
  the ledger 0 to 82 ms), and the calls in a stall grew with the run: 850, 1,277,
  1,001, 1,397, 1,869, 1,941, 2,175, 1,581, 2,264, 1,716 and 2,259 from round
  32 to the end. Each call stays
  under 250 ms; it is their number, each waiting on the disk, that holds the
  thread. The backend wrote 31 MiB a minute to disk at round 44 and 100 MiB
  a minute at round 62.

Nothing here names the caller that makes the burst, or the job: the stall
lines name different jobs each time. That is task 2's first step, with one
measured lead (the public CLI's operation namespace). The R1 run also recorded a recurrence of the Multi Review stall
[7202](../transcripts-and-observation/7202-busy-profile-follow-ups.md) task 2
waits for (a validation run queued 623 s in the host test queue), noted there.

## Needs verification

- Whether the growth appears at a normal host load; the soak ran at a load
  average of 50 to 64. Answered 2026-11-11: it does (stalls of 7 to 13 s at a
  load average of 8 to 9, see Assumptions and decisions).
- Whether a filesystem other than btrfs (ext4, APFS) shows the same disk
  waits under this workload; every run so far was on btrfs.

## Related

- [0741](0741-backend-responsiveness-under-load.md)
- [7560](7560-large-ignored-trees-in-the-worktree-watch.md)
- [0048 recurring work qualification](../transcripts-and-observation/0048-recurring-work-qualification.md)
- 7765 (retired 2026-11-11): the busy driver's burst rescan timeouts these runs found. The held turn's 2,500 removed files and the next burst's 2,500 new ones read as the same diff stats in one scan, so the `diff-scan` changed counter moved one short; the driver now waits for the removal to be rescanned (`turn-clear-backend`, [testing guide](../../development/testing-guide.md#live-idle-ab)).
