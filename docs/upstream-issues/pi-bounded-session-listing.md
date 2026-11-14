# Pi: a bounded session listing

**Tracker:** Pi, <https://github.com/earendil-works/pi/issues> (the `repository` field of `@earendil-works/pi-coding-agent`, package directory `packages/coding-agent`)
**Status:** draft
**Source:** [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md) task 1; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; measurements from 5480 (deleted) task 3 (`git show a87ca4cac^:docs/todo/agent-engines/5480-pi-resume-list-timeout-leftovers.md`)
**Filed:** —

Decision (2026-11-14, the user): until Pi ships a bounded listing, the bridge reads only the session headers it needs, falling back to Pi's listing API on a format it does not recognise, and it switches to the upstream API when that ships.

## Issue text

**Title:** Feature request: `SessionManager.list` with a limit, and without `allMessagesText`

**Summary.** `SessionManager.list(cwd, sessionDir?, onProgress?, signal?)` builds a `SessionInfo` for every session file by reading every line of it, and keeps each session's `allMessagesText` (all user and assistant text joined). A caller that only wants the newest N sessions for a picker cannot bound the work: time and memory grow with the total history size. We would like a listing that takes a limit and can skip `allMessagesText`.

**Reproduction.** Generate a session directory of repeated 1 MiB sessions (each entry a user message, an assistant message with text and a tool call, and a tool result, about 2.9 KB), then time `SessionManager.list` in a fresh process and record peak RSS.

Measured with Pi 1.4.0, Bun 1.4.4, Apple M1 Max (10 cores, 32 GiB, internal SSD), macOS 26.2, on a shared machine:

| Session file | History | Files | Listing took | Peak RSS |
| --- | --- | --- | --- | --- |
| 1 MiB | 2.2 GB | 2,048 | 2.6 s | 0.7 GB |
| 1 MiB | 8.6 GB | 8,192 | 10.2-10.4 s | 3.1-4.0 GB |
| 1 MiB | 17.2 GB | 16,384 | 21.1-21.2 s | 5.8-6.1 GB |
| 1 MiB | 34.5 GB | 32,768 | 42.7-44.9 s | 7.7-8.3 GB |
| 200 KiB | 8.8 GB | 41,943 | 11.1-11.2 s | 1.7-1.9 GB |
| 10 MiB | 17.2 GB | 1,638 | 22.3-22.9 s | 3.6-4.9 GB |

File size made little difference at the same total, so bytes, not session count, set the cost. Throughput varied about sixfold on the same machine (about 820 MB/s down to 120-150 MB/s); the cause was not isolated. How much of the memory is `allMessagesText` was not isolated either.

**Expected.** A way to list the newest N sessions whose cost does not grow with the whole history, for example `SessionManager.list(cwd, { limit, includeAllMessagesText: false, signal, onProgress })`. Ordering by last activity may still need each file's tail, but not every message's text.

**Actual.** In 1.5.0 `buildSessionInfo` streams each file line by line, parses every entry, and pushes every message's text into `allMessagesText`; `list` maps every `.jsonl` file (10 at a time) before sorting by `modified`. There is no limit and no way to skip the text.

**Versions.** Measured on Pi 1.4.0. Current pin: `@earendil-works/pi-coding-agent` 1.5.0 (`bridges/pi-bridge/package.json`), whose `list`, `listAll` and `SessionInfo` were read for this report.

**Impact.** A host that shows a resume picker caps the listing with a timeout. A history past it can never be listed, because a read that times out fills no cache, and below it the read can cost several GB of memory each time the picker opens.

## Existing-report search

None known; the sources record no search. Search terms: `SessionManager.list`, `session list slow`, `allMessagesText`, `session list memory`, `list sessions limit`, `resume picker large history`.

## Before filing

- [ ] Confirm the tracker: the package's `repository` field and the toolchain's release URL both name `earendil-works/pi`.
- [ ] Re-measure at least one row on the current pin (1.5.0 streams lines where 1.4.0 was recorded as reading whole files, so the memory figures may differ) and update the table and version line.
- [ ] Search for duplicates.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and record the URL in [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md)'s Assumptions and decisions (task 1).
