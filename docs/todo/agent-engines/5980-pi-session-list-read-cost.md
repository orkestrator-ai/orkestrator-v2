# Pi session list: what a large history costs each read

Found while measuring 5480 task 3.

## Task analysis

Analysed 2026-11-05 against `main` at `6e796ca32`. Updated 2026-11-14 for the
user's decision on task 1, and 2026-11-15 against `main` at `a8b89f154` when
task 1 was built.

### Tasks

1. **Bound the cost of listing a large Pi history**: the bridge now reads a head and tail window of the newest session files instead of every file in full, and falls back to Pi's own listing on a format it does not recognise. Status: done (2026-11-15).
2. **Switch to Pi's bounded listing once it ships**: retire the bridge's second reader of Pi's session format. Status: open (depends on a Pi release with a bounded listing; requested in [the upstream report](../../upstream-issues/pi-bounded-session-listing.md), which the user files through the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)).

### 1. Bound the cost of listing a large Pi history

**Problem.** Opening the resume dialog on a large Pi history could cost the bridge gigabytes of memory, and a history past the 30 s ceiling failed on every attempt, because a read that times out never fills the cache.

**Context.** `readResumableSessions` in `bridges/pi-bridge/src/agent-session.ts` called `SessionManager.list`, then kept only the newest `MAX_RESUME_ENTRIES` (200). In Pi 1.5.0, `buildSessionInfo` streams each whole file and keeps every session's `allMessagesText`, which the bridge does not use. Sessions are ordered by their last message, which is only known after reading them. `session-list-cache.ts` can only keep the whole result.

**Investigation.** Measured on an Apple M1 Max with 32 GiB and generated files (5480 task 3): peak RSS was 5.8 to 6.1 GB at 17.2 GB of history and 7.7 to 8.3 GB at 34.5 GB. The fix was measured on 2026-11-15 (see Current state): on the same file shape, the header reader held 0.26 to 0.33 GB and took 2 to 3 s whatever the history size, while Pi's listing reached 2.4 to 2.6 GB and 40 s at 4.1 GB.

**Decisions.**

- **What should change?** The user chose both A and B on 2026-11-14 (see Assumptions and decisions).
  - **A. Ask Pi for a bounded listing: a limit, and no `allMessagesText` when the caller does not want it.**
    - Pros: fixes memory and time at the source; the bridge keeps Pi's own reading of a session file.
    - Cons: depends on an upstream release. This is task 2.
  - **B. Have the bridge read session files itself, newest by modification time first (recommended, built as task 1).**
    - Pros: no upstream dependency; can stop at 200.
    - Cons: a second parser of Pi's private format; modification time is not the order Pi lists. Both are answered by the fallback, the format tests and the stopping rule below.
  - **C. Leave it until a user reports it.**
    - Pros: no work for a history size nobody has been seen to reach.
    - Cons: the user who reaches it cannot resume from the dialog at all.

### 2. Switch to Pi's bounded listing once it ships

**Problem.** The header reader (`bridges/pi-bridge/src/session-headers.ts`) is a second reader of Pi's private session format. It is guarded by tests and falls back to Pi on anything it does not recognise, but it still has to be rechecked on every Pi bump, and it differs from Pi's listing for files larger than its windows.

**Context.** The bounded listing is requested in [`docs/upstream-issues/pi-bounded-session-listing.md`](../../upstream-issues/pi-bounded-session-listing.md); the user files it. The Pi bump checklist in [`docs/development/upgrade-agents.md`](../../development/upgrade-agents.md#pi) says to look for it on each bump.

**Investigation.** None yet: no Pi release has a bounded listing (pinned SDK 1.5.0).

**Decisions.**

- **What replaces the reader when Pi ships a bounded listing?**
  - **Call Pi's bounded listing with the limit, keep the cache and timeout, and delete `session-headers.ts` and its test (recommended).**
    - Pros: one reader of Pi's format again; the dialog matches Pi's own listing exactly, large files included.
    - Cons: the listing's cost then depends on how Pi bounds it; re-measure it on the 5480 shape before deleting the reader.
  - **Keep the header reader and use Pi's listing only as the fallback.**
    - Pros: no change.
    - Cons: keeps a second parser that every bump must recheck, for no remaining benefit.

## Current state

- **Built (2026-11-15).** `listSessionsFromHeaders` (`bridges/pi-bridge/src/session-headers.ts`) lists the session directory, stats every file, and reads files newest-modified first, eight at a time. A file up to 1.25 MiB is read whole and matches Pi exactly; a larger file is read only at its first 1 MiB (Pi's own header-scan bound) and last 256 KiB. It stops once the next file was modified before the 200th newest last message found so far, because a message is written before its file is modified; at most 800 files that list are read. `readResumableSessions` maps its result as before and keeps the cache and the 504 timeout.
- **Fallback.** A header version outside 1 to 3, or a header, message or `session_info` entry shaped in a way Pi 1.5's listing would not read, throws `UnrecognisedSessionFormat`; the bridge then lists through `SessionManager.list` and logs `session-list.read-by-pi` with the fixed reason. Unknown entry types are ignored, as Pi ignores them.
- **Tests.** `bridges/pi-bridge/src/session-headers.test.ts` writes sessions with the pinned SDK (`SessionManager.create`, `appendMessage`, `appendSessionInfo`, `forkFrom`) and requires the reader's answer to equal `SessionManager.list`'s; pins `CURRENT_SESSION_VERSION` to the newest known version; covers the large-file windows, the documented differences, the stopping rule, every fallback reason, and the fallback through the resume list. `session-list-cache.test.ts` and `http.test.ts` now count and stall reads at the reader.
- **Measured (2026-11-15).** Fresh `bun` process per run (Bun 1.4.4, Pi 1.5.0) with `HOME`, `PI_CODING_AGENT_DIR`, `PI_SESSION_DIR` and `CWD` pointing at a temporary directory; Linux x86-64, 12 cores, 30 GiB, shared with other agents' work (load average 27 to 31). Generated sessions of the 5480 shape (user message, assistant message with text and a tool call, tool result, about 2.9 KB per entry, last message dated just before the file's modification time). "Before" is `SessionManager.list` then the newest 200, as the bridge did; "after" is `listResumableSessions`. Times include module import (about 1.4 s for the bridge); peak RSS is `VmHWM`. Importing the bridge alone peaked at 0.10 GB.

  | Session file | History | Files | Before: time | Before: peak RSS | After: time | After: peak RSS | After: files read |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 1 MiB | 2.1 GB | 2,048 | 20.4 to 20.6 s | 1.49 to 1.50 GB | 2.7 to 2.9 s | 0.27 GB | — |
  | 1 MiB | 4.1 GB | 4,096 | 40.0 s | 2.45 to 2.54 GB | 2.1 to 3.0 s | 0.26 to 0.33 GB | 200 (200 MB) |
  | 10 MiB | 4.1 GB | 410 | 39.9 to 40.9 s | 2.57 to 2.58 GB | 3.1 s | 0.26 to 0.31 GB | 200 (250 MB) |

  On both 4.1 GB histories the reader's 200 entries were identical to Pi's (path, name, created, modified, first message, parent). Larger histories were not generated: the host's disk had 15 GB free. Before, the listing's time and memory grew with the whole history; after, they depend only on the newest 200 files. The files and scripts were throwaway and were removed.

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
  ships (task 2).
- **Why both:** the header reader fixes the user's dialog now without waiting
  for a release; the fallback keeps an unknown format working through Pi's own
  reader rather than failing; the upstream API, once shipped, removes the
  second parser.

### Task 1: a head and a tail window, not the header line alone

- **Chose:** read each file's first 1 MiB and last 256 KiB, or the whole file
  when it is no larger than both. The header line alone gives the id, working
  directory, creation time and parent, but not the three things the dialog
  also shows: the first prompt (near the start), the name (a `session_info`
  entry, which the backend's generated title writes after the first turn) and
  the last message's time (at the end).
- **Differences from Pi, documented at the top of `session-headers.ts`:** on a
  file larger than both windows, a name set only between them is not seen, a
  first prompt that does not end inside the head window gives no detail, and a
  tail with no whole message dates the session by the file's modification
  time. Smaller files match Pi exactly; the 5480 shape (1 MiB files) is read
  whole.
- **Why:** the windows bound both memory and the bytes read (at most 1.25 MiB
  per file), which a full streamed read of the newest 200 files would not.

### Task 1: which files to read

- **Chose:** newest-modified first, stopping once the next file was modified
  before the 200th newest last message found, with a hard cap of 800 files
  that list. Under the premise that a message is written before its file is
  modified, this picks exactly Pi's newest 200. Files copied without their
  modification times break the premise; the cap keeps the read bounded there,
  at the cost of possibly missing a session Pi would list.
- **Working-directory filter:** applied whenever `PI_SESSION_DIR` is set, as
  Pi applies it except when that directory is Pi's own default for the
  workspace; the bridge does not reproduce Pi's private directory-name
  encoding to detect that case.

### Task 1: the whole list falls back, not one file

- **Chose:** one unrecognised file hands the whole list to `SessionManager.list`.
  The fallback then answers exactly as before this change, which is the
  safe outcome for a format the reader has not been checked against; a Pi
  bump that changes the format fails `session-headers.test.ts` first. A
  per-file fallback would need Pi's unexported per-file step.

### Task 1: manual check left

Whether the reader picks the same sessions, names and first prompts as Pi's
own listing on a real (not generated) history needs the user's own Pi
history. The [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
has a content-free comparison command for a copy of it.

## Related

- `5480-pi-resume-list-timeout-leftovers.md` (deleted 2026-11-06): the measurement and the reason shown in the dialog.
- to-do 1202 task 6 (retired 2026-11-10): the cache and the ceiling.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): filing the upstream report is its "File the upstream reports" item; the real-history check of task 1 is its own item.
- [Upstream report: Pi bounded session listing](../../upstream-issues/pi-bounded-session-listing.md)
