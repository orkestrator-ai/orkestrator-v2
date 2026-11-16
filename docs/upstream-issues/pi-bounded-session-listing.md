# Pi: a bounded session listing

**Tracker:** Pi, <https://github.com/earendil-works/pi/issues> (the `repository` field of `@earendil-works/pi-coding-agent`, package directory `packages/coding-agent`)
**Status:** draft (2026-11-15): Pi's contribution rules ask for a one-screen issue on one of its GitHub templates, written in the filer's own voice, and auto-close issues from new contributors; seven earlier reports of this cost were auto-closed and never reopened. It needs the user to write a short version from the notes below (see Before filing), so an agent cannot finish it.
**Source:** [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md) task 2; filed through the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)'s "file the upstream reports marked ready" item; measurements from 5480 (deleted) task 3 (`git show a87ca4cac^:docs/todo/agent-engines/5480-pi-resume-list-timeout-leftovers.md`)
**Filed:** —

Decision (2026-11-14, the user): until Pi ships a bounded listing, the bridge reads only the session headers it needs, falling back to Pi's listing API on a format it does not recognise, and it switches to the upstream API when that ships. The header reader shipped on 2026-11-15 (`bridges/pi-bridge/src/session-headers.ts`, 5980 task 1); switching is 5980 task 2.

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

Re-measured with Pi 1.5.0, Bun 1.4.4, Linux x86-64 (12 cores, 30 GiB), on a shared machine, in a fresh process per run (times include importing the SDK):

| Session file | History | Files | Listing took | Peak RSS |
| --- | --- | --- | --- | --- |
| 1 MiB | 2.1 GB | 2,048 | 20.4-20.6 s | 1.49-1.50 GB |
| 1 MiB | 4.1 GB | 4,096 | 40.0 s | 2.45-2.54 GB |
| 10 MiB | 4.1 GB | 410 | 39.9-40.9 s | 2.57-2.58 GB |

File size made little difference at the same total, so bytes, not session count, set the cost. Throughput varied about sixfold on the same machine (about 820 MB/s down to 120-150 MB/s); the cause was not isolated. On macOS with 1.5.0 (see Versions), the 2,048 × 1 MiB history (2.1 GB) took 1.7 s and 1.4-1.5 GB at peak, with 0.95 GB of it kept as `allMessagesText`.

**Expected.** A way to list the newest N sessions whose cost does not grow with the whole history, for example `SessionManager.list(cwd, { limit, includeAllMessagesText: false, signal, onProgress })`. Ordering by last activity may still need each file's tail, but not every message's text.

**Actual.** In 1.5.0 `buildSessionInfo` streams each file line by line, parses every entry, and pushes every message's text into `allMessagesText`; `list` maps every `.jsonl` file (10 at a time) before sorting by `modified`. There is no limit and no way to skip the text.

**Versions.** Tables measured on Pi 1.4.0 (macOS) and 1.5.0 (Linux); the pinned SDK's `list`, `listAll` and `SessionInfo` were read for this report. Re-measured on the current pin, `@earendil-works/pi-coding-agent` 1.5.0 (`bridges/pi-bridge/package.json`), on 2026-11-15: 2,048 sessions of 1 MiB (2.1 GB) took 1.66-1.72 s with a peak RSS of 1.41-1.48 GB, three runs in fresh processes (Bun 1.4.4, Apple Silicon Mac mini, 18 cores, 64 GiB, external APFS SSD, macOS 27.2, load average 12-15). The returned `allMessagesText` held 947 M characters, about 45% of the bytes read, so most of the memory in this macOS measurement is that field. The newest published is 1.5.2 (2026-11-10); `list` was not re-read there.

**Impact.** A host that shows a resume picker caps the listing with a timeout. A history past it can never be listed, because a read that times out fills no cache, and below it the read can cost several GB of memory each time the picker opens.

## Existing-report search

Searched 2026-11-15 (`gh search issues` and `gh search prs` in earendil-works/pi, open and closed) for: `SessionManager.list`, `session list slow`, `allMessagesText`, `session list memory`, `list sessions limit`, `resume picker large`, `sessions list performance`, `session list limit`.

The same request has been made at least seven times, and every one was auto-closed by Pi's new-contributor gate (`NOT_PLANNED`, closed by the bot, no maintainer reply, never reopened):

- [#8013](https://github.com/earendil-works/pi/issues/8013) (2026-08-12): `/resume` All eagerly scans giant JSONL sessions and builds `allMessagesText`.
- [#8357](https://github.com/earendil-works/pi/issues/8357) (2026-08-19): avoid scanning full session files when listing sessions.
- [#8683](https://github.com/earendil-works/pi/issues/8683) (2026-08-26): `SessionManager.listAll()` scans every transcript body for metadata-only lookups.
- [#8710](https://github.com/earendil-works/pi/issues/8710) (2026-08-27): `/resume` fully parses every session file just to enable search.
- [#8762](https://github.com/earendil-works/pi/issues/8762) (2026-08-28): the selector fully parses every session file; its author drafted a 64 KB prefix scan (about 100 times faster).
- [#9576](https://github.com/earendil-works/pi/issues/9576) (2026-09-14) and [#10374](https://github.com/earendil-works/pi/issues/10374) (2026-10-02): show recent sessions first; cache listing metadata by file identity.

Related, merged: [#11296](https://github.com/earendil-works/pi/pull/11296) searches session fields separately, which still relies on `allMessagesText`. No open issue or pull request offers a limit or a way to skip the text.

## Before filing

- [x] Confirm the tracker: the package's `repository` field and the toolchain's release URL both name `earendil-works/pi`. Done 2026-11-15: 1.5.0's `package.json` has `git+https://github.com/earendil-works/pi.git`, directory `packages/coding-agent`; `packages/toolchain/src/manifest.ts` downloads from `github.com/earendil-works/pi/releases`; the repository has issues enabled.
- [x] Re-measure at least one row on the current pin and update the table and version line. Done 2026-11-15 on Linux (table above; 5980 task 1) and macOS for the 2,048 × 1 MiB row (Versions). Generated files only, in this build's git-ignored `output/`, with `HOME` and `PI_CODING_AGENT_DIR` pointed at a temporary directory; removed afterwards. Each generated entry group (user message, assistant text and tool call, tool result) was about 3.7 KB, against 2.9 KB in the 1.4.0 rows.
- [x] Search for duplicates. Done 2026-11-15: seven auto-closed duplicates (above), none open.
- [ ] **For the user:** Pi's [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) asks for one of its two issue templates, at most one screen, "in your own voice (do not use an LLM to generate text, if you must, follow up with a clearly AI labeled comment)", and warns that agent-generated issues can get an account blocked. The issue text above is too long and agent-written, so do not paste it. Either write a short issue yourself (the request, the 1.5.0 numbers, and links to #8683 and #8762), or ask on Pi's Discord, or do not file: the Pi bridge already reads only session headers (the 2026-11-14 decision above, [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md)). Then set **Status** to `ready to file` or delete this file.

## After filing

Record the URL and date under **Filed**, set **Status** to `filed`, and record the URL in [5980](../todo/agent-engines/5980-pi-session-list-read-cost.md)'s Assumptions and decisions (task 2).
