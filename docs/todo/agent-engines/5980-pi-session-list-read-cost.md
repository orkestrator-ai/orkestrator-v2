# Pi session list: what a large history costs each read

Found while measuring 5480 task 3.

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`. Updated 2026-11-14 for the
user's decision on task 1.

### Tasks

1. **Bound the cost of listing a large Pi history**: a list reads every session file in full, holds gigabytes while it does, and a history that exceeds the ceiling can never be listed. The user chose both routes on 2026-11-14: the bridge reads only the session headers it needs now, and switches to Pi's bounded listing once it ships ([upstream report](../../upstream-issues/pi-bounded-session-listing.md)). Status: open (the header reader is agent work).

### 1. Bound the cost of listing a large Pi history

**Problem.** Opening the resume dialog on a large Pi history can cost the bridge gigabytes of memory, and a history past the 30 s ceiling fails on every attempt, because a read that times out never fills the cache. The user is now told why, but has no way to get the list.

**Context.** `readResumableSessions` in `bridges/pi-bridge/src/agent-session.ts` calls `SessionManager.list`, then keeps only the newest `MAX_RESUME_ENTRIES` (200). In Pi 1.4.0, `buildSessionInfo` reads each whole file and keeps every session's `allMessagesText`, which the bridge does not use. Sessions are ordered by their last message, which is only known after reading them. `session-list-cache.ts` can only keep the whole result.

**Investigation.** Measured on an Apple M1 Max with 32 GiB and generated files (5480 task 3): peak RSS was 5.8 to 6.1 GB at 17.2 GB of history and 7.7 to 8.3 GB at 34.5 GB, and reads given up on at 30 s had reached 6.6 GB on one run and 0.9 GB on another. On this shared machine, the estimated 30 s crossing was about 24.5 GB at 820 MB/s (interpolated) and about 3.5 to 4.5 GB at 120 to 150 MB/s (extrapolated). The cause of the throughput difference was not isolated; load average alone did not predict it. How much of the memory is `allMessagesText` was not isolated, and how many real users have a history this large is unknown. The dialog only reads this when opened, so it is not a background cost.

**Decisions.**

- **What should change?**
  - **Ask Pi for a bounded listing: a limit, and no `allMessagesText` when the caller does not want it (recommended).**
    - Pros: fixes memory and time at the source; the bridge keeps Pi's own reading of a session file.
    - Cons: depends on an upstream release; ordering by last message may still need each file's tail. Raising it upstream is an outward action: the report is drafted in [`docs/upstream-issues/pi-bounded-session-listing.md`](../../upstream-issues/pi-bounded-session-listing.md), and the user files it.
  - **Have the bridge read session files itself, newest by modification time first.**
    - Pros: no upstream dependency; can stop at 200.
    - Cons: a second parser of Pi's private format, which `version-drift.test.ts` cannot guard, and modification time is not the order Pi lists.
  - **Leave it until a user reports it.**
    - Pros: no work for a history size nobody has been seen to reach.
    - Cons: the user who reaches it cannot resume from the dialog at all.

## Assumptions and decisions

### Task 1: retain measured rates and uncertainty

Review correction (2026-11-05): describe the crossing estimates by measured throughput on the shared Apple M1 Max, without attributing the difference to host load. The measurements in 5480 did not isolate its cause; no new measurements were taken.

### Task 1: header reader now, upstream listing later (user decision, 2026-11-14)

- **Chose:** options A and B together. The user (maintainer) decided on
  2026-11-14 that the Pi bridge reads only the session headers it needs to
  list resumable sessions, pinned by tests against Pi's real session files,
  and falls back to Pi's own listing API (`SessionManager.list`) whenever it
  meets a format it does not recognise. The bounded-listing request goes
  upstream as
  [`docs/upstream-issues/pi-bounded-session-listing.md`](../../upstream-issues/pi-bounded-session-listing.md)
  (the user files it), and the bridge switches to the upstream API when it
  ships.
- **What the agent does:** build the header reader in
  `bridges/pi-bridge/src/agent-session.ts` (or a sibling module) with a test
  that fails when the pinned SDK's session format changes, so a Pi bump
  cannot silently break it (see "Pi bridge" in the root `AGENTS.md`: the SDK
  and the `pi` binary bump together). Keep the newest `MAX_RESUME_ENTRIES`
  and the order Pi uses as closely as the headers allow, and say in the code
  where it differs. Measure peak memory on the 5480 generated history before
  and after.
- **Why both:** the header reader fixes the user's dialog now without waiting
  for a release; the fallback keeps an unknown format working through Pi's own
  reader rather than failing; the upstream API, once shipped, removes the
  second parser.

## Related

- `5480-pi-resume-list-timeout-leftovers.md` (deleted 2026-11-06): the measurement and the reason shown in the dialog.
- to-do 1202 task 6 (retired 2026-11-10): the cache and the ceiling.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the choice of route was there from 2026-11-10 until the user answered it on 2026-11-14; filing the upstream report is its "File the upstream reports" item.
- [Upstream report: Pi bounded session listing](../../upstream-issues/pi-bounded-session-listing.md)
