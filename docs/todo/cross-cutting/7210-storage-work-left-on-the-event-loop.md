# Storage work still on the backend's event loop after ST-13

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`. Found while doing
to-do 1202 task 7 (retired 2026-11-10) (ST-13), which moved the
snapshot check's free-page release into a child process. Three pieces of
storage maintenance still run synchronously on the backend's connection.
They were measured with `apps/backend/scripts/storage-maintenance-stall.ts`
(a 512 MiB main database and a 256 MiB ledger, four runs a round, two rounds,
macOS, load average 12 to 17 on the shared build host). Task 4 was analysed
2026-11-06 against `main` at `b0ad3f747`.

### Tasks

1. **The deletion scrub's free-page release**: `scrubDeletedContent` returns up to 4,096 pages (16 MiB) in one synchronous `incremental_vacuum` after a deletion. Status: open.
2. **The pre-migration snapshot**: `snapshotBeforeMigration` copies and checks the whole database in-process before a schema migration. Status: open (recommended: leave it).
3. **`PRAGMA optimize` on every snapshot check**: Status: open (recommended: leave it).
4. **The upkeep's free-page release holding backend writers behind the write lock**: Status: done.

### 1. The deletion scrub's free-page release

**Problem.** A deletion that frees content (an environment, a session, a
mail thread) calls `scrubDeletedContent` (`storage-database.ts`), which runs
`releaseFreePages()` with its default of 4,096 pages and a truncating
checkpoint on the backend's own connection. In the benchmark, a scrub after a
deletion held the event loop 169–173 ms p50 and up to 321 ms over eight
runs each before and after ST-13 (earlier runs on the same host: 99–140 ms
p50, up to 586 ms).

**Context.** The scrub is a privacy step, not upkeep: `secure_delete` zeroes
the freed pages and the checkpoint moves the deleting transaction out of the
WAL. The release half only gives space back, which the five-minute upkeep
now also does off the loop (`releaseFreePagesInChildProcess` in
`storage-backups.ts`). The checkpoint half already never waits
(`busy_timeout = 0`) and retries from a timer.

**Investigation.** Not split yet: which share of the 170 ms is the
release and which the checkpoint was not measured. `scripts/benchmark-*`
has no deletion workload; the stall script's `scrub` step deletes a share of
synthetic rows and times the whole call.

**Decisions.**

- **Move the scrub's release to the upkeep child?**
  - **Drop the release from the scrub and leave it to the upkeep, keeping the scrub's checkpoint in-process (recommended).**
    - Pros: the scrub's privacy guarantee does not depend on the release (freed pages are zeroed either way); the stall drops to the checkpoint's share.
    - Cons: the file stays larger for up to five minutes after a deletion; the share of the stall that is the checkpoint is unknown until measured.
  - **Start a release child from the scrub.**
    - Pros: space comes back at once.
    - Cons: a child per deletion; deletions can come in bursts.
  - **Leave it.**
    - Pros: no change.
    - Cons: a deletion keeps costing a few hundred milliseconds of event loop on a large database.

### 2. The pre-migration snapshot

**Problem.** `snapshotBeforeMigration` runs `VACUUM INTO` and `quick_check`
in-process: 1.5–1.9 s p50 and up to 2.9 s for 512 MiB in the benchmark.

**Context.** It runs only while the database opens, before a schema
migration, and the open waits for it (a failed copy aborts the open rather
than migrating unprotected; see [storage.md](../../architecture/storage.md#snapshots)).
Nothing is served yet, so the event loop has no other work.

**Investigation.** None beyond the measurement.

**Decisions.**

- **Move it to a child process?**
  - **Leave it (recommended).**
    - Pros: the open must wait for the copy anyway; one-off per schema version.
    - Cons: start-up is seconds slower on a large database when a migration is due.
  - **Copy in the child the hourly copy uses.**
    - Pros: the same code path for every copy.
    - Cons: an asynchronous step inside a synchronous open; no stall saved, because nothing else runs then.

### 3. `PRAGMA optimize` on every snapshot check

**Problem.** `runDatabaseUpkeep` runs `PRAGMA optimize` on the backend's
connection every five minutes: 11–13 ms p50, up to 44 ms in the benchmark.

**Context.** `optimize` analyses the tables this connection's own queries
used, so another connection (a child) would not know which tables to look
at.

**Investigation.** None beyond the measurement.

**Decisions.**

- **Change it?**
  - **Leave it (recommended).**
    - Pros: tens of milliseconds every five minutes; it must run on this connection.
    - Cons: none measured.
  - **Run it less often (hourly, with the copy).**
    - Pros: a twelfth of the cost.
    - Cons: planner statistics refresh less often; the cost is already small.

### 4. The upkeep's free-page release holding backend writers behind the write lock

**Problem.** `releaseFreePagesInChildProcess` (`storage-backups.ts`) returns
up to 1 GiB of free pages per upkeep check, 256 pages per `incremental_vacuum`
transaction. Each step holds the write lock. A backend write that arrives during
a step waits for it inside `bun:sqlite`'s synchronous call, so the event loop
waits too. The question was whether the 5 ms pause between steps let the child
take the lock again before a waiting writer, starving it for up to its 10 s
`busy_timeout`.

**Context.** This only matters while there are many free pages, for example
after the ledger move freed about 1.2 GB. mini's database had 177 free pages
when this was analysed. The backend's connection uses `busy_timeout = 10_000`.
The child uses 1 000 ms and stops when it finds the database busy.

**Investigation.** `apps/backend/scripts/storage-release-writer-stall.ts`
builds a throwaway 1.3 GB database under `output/benchmarks/`: 256 MiB of live
rows interleaved with 1 GiB of rows that are then deleted. It runs the real
child release beside a `StorageDatabase` writer committing every 10 ms, and
measures write latency, a 2 ms timer probe and the backend's stall monitor. It
also traces each child step's lock hold and checkpoint, and can add four
processes that write and fsync 4 MiB blocks on the same disk. Measured
2026-11-06 on macOS, Bun 1.4.4 (SQLite 3.54.0), on the shared build host.

- **No starvation between steps.** Bun's SQLite is built with
  `SQLITE_ENABLE_SETLK_TIMEOUT`. A writer blocked on the lock acquired it
  0.0–0.3 ms after the holder committed (12 trials). It does not sleep through
  the 1–100 ms busy-handler backoff, so the 5 ms gap is enough, and no write
  ever reached SQLITE_BUSY.
- **Idle disk: harmless.** Worst write 19–71 ms over eight releases of 1 GiB,
  each 17–20 s. The stall monitor's worst figure was the same.
- **Busy disk: long holds.** With the four fsync writers, eleven releases that ran
  to the 1 GiB budget had a worst write of 1.53–4.16 s (median 2.4 s) and 2–7
  writes of at least 1 s each, over 106–147 s. The longest single hold was
  1.4–2.5 s. Writers-only control runs on the same load: 0.27–0.49 s worst write
  in 10 s and 60 s windows, but 1.50–1.85 s in three 30 s windows. The disk
  alone sometimes stalls a commit past 1 s.
- **Why steps are slow.** Each step reads the pages it moves while it holds the
  lock. With the whole file read into the page cache first (`warm`), the median
  hold under load fell from 26–72 ms to 6–9 ms. The tail still remained: worst
  write 0.73 s in one run and 1.55 s with 4 writes ≥ 1 s in the other. So
  writes stalled behind the disk queue also contribute.
- **Variants that did not help under load.** A 100 ms pause made it worse,
  because the release ran 2–3 times longer: 3.0 s and 4.5 s worst, 12–13 writes
  ≥ 1 s. Child `synchronous = NORMAL` gave 3.3 s and 3.4 s. 64-page steps gave
  2.8 s, with the longest hold still 3.9 s. Prefetching the last 1 024 pages
  before each step gave 2.0 s.
- **Stopping at a slow step (implemented).** One check now stops at its first
  slow step. Under load, twenty checks run back to back (one hundred minutes of
  checks compressed into 7–37 s) gave the following. At a 250 ms threshold:
  worst write 0.55–4.66 s, 11 writes ≥ 1 s over 160 checks. At 100 ms, in five
  runs: 0.36–2.54 s, 2 writes ≥ 1 s over 100 checks, and 6 144–43 776 pages
  released per twenty checks. That is about 0.02 writes ≥ 1 s per check at
  100 ms and 0.07 at 250 ms, against about 4.4 per release before. Without the
  synthetic load the release still freed the whole 1 GiB, but other work on
  the host sometimes stopped it early. Twenty checks back to back then had
  worst writes of 0.13–0.93 s, against 0.06–0.07 s for one full run in the same
  round. Each restart pays a cold first step and checkpoint, which back-to-back
  checks pay many times and real checks, five minutes apart, pay once.

**Decisions.**

- **How should the release stop holding up backend writers on a busy disk?**
  - **End the run at a step slower than 100 ms, so the next check carries on (recommended, implemented).**
    - Pros: bounds the exposure to about one slow step per five-minute check
      instead of a burst. Costs nothing while every step stays under 100 ms. The release then runs
      mostly when the disk is quiet. It is a three-line change in the helper.
    - Cons: the step that detects the busy disk has already held the lock.
      Under sustained load the release crawls: 6 144–43 776 pages per twenty
      checks. A disk that is busy all the time spreads its slow steps over hours
      rather than avoiding them. A run stopped early costs the next check a cold
      first step (up to 0.3 s of writes held, 0.9 s once on a noisy host).
  - **A pause longer than SQLite's busy-handler backoff (100–250 ms).**
    - Pros: one constant.
    - Cons: it targets starvation between steps, which this SQLite build does
      not have. Measured, it stretched the release and made it worse under load.
  - **The child yields when a backend writer is waiting, through a lease row or
    a marker.**
    - Pros: would hand the lock over at once.
    - Cons: the lock is already handed over at once. The cost is the hold of the
      step in progress, which a marker cannot shorten. It would also add a write
      to every backend commit.
  - **Lower the backend's busy timeout during upkeep.**
    - Pros: caps the stall.
    - Cons: turns a delayed write into a failed one (SQLITE_BUSY) for every
      caller, which is worse than a stall.
  - **Accept the risk.**
    - Pros: no change.
    - Cons: after a large deletion on a busy disk, each check holds the event
      loop for seconds several times in a couple of minutes, enough for the
      gateway, bridges and mail to time out.
- **Threshold.**
  - **100 ms (recommended, implemented).**
    - Pros: above every step on an idle disk on a quiet host (at most 60 ms,
      plus one 121 ms outlier), and below the multi-second tail. When other
      work on the host kept the disk busy without the synthetic load, steps
      reached 0.16–3.6 s, and stopping there is the point. In the measurements it stopped at a modest
      step more often than 250 ms did.
    - Cons: an idle but slow disk may stop early now and then, which only moves
      pages to the next check.
  - **250 ms.**
    - Pros: fewer early stops.
    - Cons: by the time a step is over 250 ms it is more often a multi-second
      one: 11 writes ≥ 1 s over 160 checks, against 2 over 100 at 100 ms.

## Assumptions and decisions

### Task 4: stop the release at a slow step

The child times each step from `incremental_vacuum` through its checkpoint and
ends the run once a step exceeds `UPKEEP_RELEASE_SLOW_STEP_MS` (100 ms). The
step's pages still count. The threshold is an option of
`releaseFreePagesInChildProcess` (`slowStepMs`), so tests that need every step
to run can raise it. The pause stays at 5 ms because the lock is already handed
straight over. The child's `synchronous = FULL` is unchanged because `NORMAL`
measured no better. The `warm` and `prefetch` experiments are kept in the
script but not adopted. Warming reads the whole file on every check, and that
cost grows with the database rather than with the free list. It also still left
writes over 1 s.

### Task 4: measured on macOS only

All the figures come from this host's APFS SSD with synthetic fsync load. Linux
(the Beelink) and mini's own disk were not measured. The mechanism (pages read
under the lock) does not depend on the platform, but the threshold's margin
on an idle disk was only checked here.

## Related

- to-do 1202 task 7 (retired 2026-11-10) (ST-13).
- [5180](5180-sqlite-durability-tiers.md): `synchronous` and `secure_delete` tiering, which would change what each step costs.
