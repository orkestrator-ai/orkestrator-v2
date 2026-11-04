# E26: Local desktop transport

This file combines 2 reports into one batch to build together. Both in `backend-process.ts`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0400](#0400-local-desktop-windows-relay-every-event-and-invoke-through-electron-main) | High | DK-1, DK-2: Local desktop windows relay every event and invoke through Electron main |
| [0860](#0860-finish-the-electron-relay-and-file-writer) | Low | R7's remainder (L6) and DK-18: batching, line bound and skipping the relay. |

## 0400: Local desktop windows relay every event and invoke through Electron main

### Task analysis

The report's fix for DK-2 is DK-1's transport change, so both findings share this file.

#### Tasks

1. **Capture the baseline**: measure main-process CPU and IPC volume with terminal output running before changing the transport. Status: partly done (2026-11-04: event, byte and command counts in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 12; main-process CPU was not measured).
2. **Filtered event stream for local windows**: move local windows onto the direct gateway transport with filtered SSE, behind a per-window rollback switch. Status: done (2026-11-04, off by default; the default flip is [4501](../../todo/cross-cutting/4501-local-window-transport-default.md)).
3. **Local `invoke` off the main-process hop**: send a local window's commands over the same direct transport. Status: done (2026-11-04, with task 2).

#### 1. Capture the baseline

**Problem.** Without a before figure, the transport change cannot be shown to have helped.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1: small fixes ship without waiting, but this task is a structural one and needs a baseline first.

**Investigation.** The report measured nothing here. The gateway metrics exist, but nothing I read counts bytes sent over `orkestrator:event`.

**Decisions.**

- **What to measure?**
  - **Electron main CPU and event bytes with one busy terminal and two windows, in an isolated `dev:test` profile (recommended).**
    - Pros: it covers the case the finding describes; it can be repeated after task 2.
    - Cons: needs a temporary counter in main.
  - **Launch-to-idle timing only.**
    - Pros: no new counter.
    - Cons: does not exercise terminal output, which is the main cost.

#### 2. Filtered event stream for local windows

**Problem.** Every PTY and tmux byte of every environment is JSON-encoded, parsed on the Electron main thread and structured-cloned to each window of that connection, then dropped in the preload if nothing listens.

**Context.** Decided 2026-11-01 in 1202 task 12: local windows use the direct gateway transport, with a per-window rollback switch, starting with filtered SSE and not tied to the terminal WebSocket. That decision stands; only the switch's scope below is open.

**Investigation.** `apps/desktop/electron/backend-process.ts:662-663` opens `/__orkestrator/events` with only a cursor. Events reach each window through `apps/desktop/electron/desktop-window-contexts.ts:58` and `:124`. The filter happens after the clone, in `apps/desktop/electron/preload-api.ts:343-347`. The browser path already asks for `excludeEvents` with the `terminal-output-` prefix (`apps/web/src/lib/native/web-gateway.ts:48`, `:500`). Remote windows already use `installRemoteGatewayRequestAuth` (`apps/desktop/electron/main.ts:919`), which is the mechanism a local window would reuse.

**Decisions.**

- **Rollback switch scope?** (Decided 2026-11-01 in 1202: the first.)
  - **A per-window setting read at window creation, defaulting to the new transport after one release behind it (recommended).**
    - Pros: a user with a broken window can fall back without a new build.
    - Cons: two transports to keep working for a release.
  - **A build-time flag.**
    - Pros: one transport at runtime.
    - Cons: no way back without a release.

#### 3. Local `invoke` off the main-process hop

**Problem.** A local `invoke` is cloned from the renderer, stringified and fetched in main, parsed with `response.json()` in main and cloned back, so large terminal snapshots, transcripts and base64 reads are parsed on the main thread.

**Context.** This is DK-2. The report says the DK-1 transport change removes the hop, and at minimum the raw body could pass through without being parsed in main.

**Investigation.** The path is `apps/desktop/electron/preload-api.ts:355`, `apps/desktop/electron/ipc.ts:297-305` and `apps/desktop/electron/backend-process.ts:490-506`. `invoke` first offers each command to `terminalInput.invoke` (`backend-process.ts:491`), the sequencer that orders terminal input, so that ordering has to survive any move.

**Decisions.**

- **Move commands, or only stop parsing in main?**
  - **Move a local window's commands onto the direct transport with the events (recommended).**
    - Pros: removes all four serialisations; one transport per window.
    - Cons: terminal input sequencing has to move or be preserved.
  - **Pass the raw response body through main without parsing it.**
    - Pros: small; no transport change.
    - Cons: still crosses IPC twice; it cannot help until the renderer accepts raw bodies.

### Current state

Parts 0400's tasks 2 and 3 are built behind `global.localWindowGatewayTransport`, off by default. With it off, `backend-process.ts` opens the unfiltered stream and local windows invoke through IPC, as before. Part 0860 is not built.

### Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) on missed-event detection and on metrics staying content-free apply. Terminal output is outside authoritative replay, so a reconnect must still trigger exact snapshot recovery (`backend-process.ts:678-680`).

### Needs verification

- Real main-process cost; the report's impact is reasoned, not measured.
- 1202 infers from code that local desktop traffic never compresses because `backend-process.ts` calls control-only routes. The direct transport uses the same control listener, and `compressionModeForListener` never compresses there, so this still holds (read from code, not tested).

## 0860: Finish the Electron relay and file writer

### Task analysis

#### Tasks

1. **Batch file appends**: one write per burst, with `mkdir` only when needed. Status: done (2026-11-04, with the recommended options; see [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16).
2. **Bound relay line length**: `readline` buffers a whole line. Status: open.
3. **Skip the relay when nothing consumes it**: packaged app with saving off. Status: open.

#### 1. Batch file appends

**Problem.** Each entry does `mkdir` plus `appendFile` (open, write, close) in a strict chain, so a burst is capped at filesystem latency and the 4 MiB queue starts dropping.

**Context.** This is efficiency finding DK-18, tracked in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16. That analysis is not repeated here. The sampled log was 12.5k lines in a day on one machine, which the report calls fine.

**Investigation.** `packages/protocol/src/node/application-logging.ts:438-447` is the chain, and `MAX_PENDING_LOG_BYTES` is 4 MiB (`:30`). Standalone backends use the same writer. `flush` returns the pending chain (`:545`), which the quit path relies on (`:568-577`). `resolveTarget` chooses the file per entry, rolling on the day, the format and `maxFileBytes` (`:395-425`). The shared logger migration (#1558, #1583, #1619) did not change this.

**Decisions.**

- **When to flush?**
  - **Coalesce per tick into one write (recommended; DK-18's fix).**
    - Pros: no added latency at low volume; no timer.
    - Cons: an entry waits only for the current write, so a slow disk still queues.
  - **Every ~100 ms, flushing synchronously for `error` (the report's other form).**
    - Pros: fewer writes under a sustained trickle.
    - Cons: a timer, and up to one batch lost on a hard crash, which is the report's named trade-off.
- **Keep the file handle open between batches?**
  - **No: one `appendFile` per batch, retrying through `mkdir` only on `ENOENT` (recommended).**
    - Pros: no descriptor to manage; a deleted log directory still recovers; a batch splits at rollover through the existing `resolveTarget` logic.
    - Cons: still one open and close per tick.
  - **Yes, while the day and index are unchanged, as both reports suggest.**
    - Pros: no open per batch.
    - Cons: a handle to close on rollover and quit, and a rotated or deleted file goes on being written unseen.

#### 2. Bound relay line length

**Problem.** A backend line with no newline grows the desktop's memory without bound.

**Context.** The bridge hop already solves this: `BRIDGE_OUTPUT_LINE_LIMIT` is 64 KiB (`apps/backend/src/core/bridge-output-redaction.ts:34`), cutting at the limit "rather than lose output" (`:77`). Backend logger lines are bounded, so only raw output can reach this.

**Investigation.** `apps/desktop/electron/backend-process.ts:931` and `:974` use `createInterface` with no limit. The ready message arrives on the same stdout reader.

**Decisions.**

- **How to bound it?**
  - **Reuse the bridge hop's line splitter from a shared module (recommended).**
    - Pros: one tested behaviour for two relays, and keeps output by cutting at the limit.
    - Cons: moves code into `packages/protocol`, and `readline` also handled `\r\n` and U+2028, which the logger's escaping relies on (`docs/architecture/logging.md:449-450`).
  - **Leave it.**
    - Pros: no code; an unbounded line needs a runaway raw `console` in the backend.
    - Cons: the desktop's main process is what grows.

#### 3. Skip the relay when nothing consumes it

**Problem.** With saving off in a packaged app, every backend line is parsed and re-emitted on the main thread to a stdout nobody reads.

**Context.** The tee is cheap when off (one comparison, `application-logging.ts:452`). The cost left is the relay's parse and console call.

**Investigation.** `relayBackendLine` (`backend-process.ts:46-64`) always parses, and it is also how the `policy.changed` hint arrives (`:58-61`), so the relay cannot simply stop. In packaged apps stdout is usually unread, but this is not checked anywhere.

**Decisions.**

- **Add a skip?**
  - **Not until a measurement shows main-thread cost (recommended).**
    - Pros: the prefix check already rejects a non-record cheaply; the hint and the ready message must keep flowing, so a skip is not a one-liner.
    - Cons: pays a small constant cost per line.
  - **Keep parsing records but drop the console write when saving is off and stdout is not a TTY.**
    - Pros: removes the write.
    - Cons: a developer running a packaged app from a terminal loses output unless it is detected correctly.

### Current state

Done from R7, so not tasks here:

- **Levels survive.** The backend writes JSON records and the desktop re-emits them at their level, with a JSON object no longer dropped (`#1558`, the relay in `backend-process.ts:46-64`; rejected alternatives are in `docs/architecture/logging.md:630-632`).
- **Updater logger.** `createUpdaterLibraryLogger` (`apps/desktop/electron/updater-log.ts:35`, set at `main.ts:781`, `#1558`) keeps the plan at `debug`.
- **Startup parse.** The listener is not detached, because it also relays, but `parseReadyMessage` returns early unless a line starts with `{` (`backend-process.ts:73`), which removes the thrown-and-caught cost the report named.

`docs/architecture/logging.md:634-635` records the rest as undecided and not built.

### Constraints and rationale

- The byte bounds and drop markers must not change.
- A log line must be one entry, so a chunk boundary must not split one.
- Quit must still flush what was accepted (`application-logging.ts:568-577`).

### Needs verification

- Whether a burst reaches the 4 MiB queue bound in practice. The logging report's 12.5k lines a day on one machine suggests rarely; not measured here.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 12
- [Logging and database report, R7](../2026-10-29-logging-and-database-efficiency.md#r7-fix-the-electron-relay-and-file-writer-l6-l2) and [L6](../2026-10-29-logging-and-database-efficiency.md#l6-the-electron-relay-is-always-on-lossy-and-unbatched-medium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16 (DK-18)
- [2026-10-27 efficiency review, DK-18](../2026-10-27-efficiency.md)
