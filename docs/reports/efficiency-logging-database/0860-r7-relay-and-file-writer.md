# Finish the Electron relay and file writer

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Batch file appends**: one write per burst, with `mkdir` only when needed. Status: open.
2. **Bound relay line length**: `readline` buffers a whole line. Status: open.
3. **Skip the relay when nothing consumes it**: packaged app with saving off. Status: open.

### 1. Batch file appends

**Problem.** Each entry does `mkdir` plus `appendFile` (open, write, close) in a strict chain, so a burst is capped at filesystem latency and the 4 MiB queue starts dropping.

**Context.** This is efficiency finding DK-18, tracked as open in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16. That analysis is not repeated here. The sampled log was 12.5k lines in a day on one machine, which the report calls fine.

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

### 2. Bound relay line length

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

### 3. Skip the relay when nothing consumes it

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

## Current state

Done from R7, so not tasks here:

- **Levels survive.** The backend writes JSON records and the desktop re-emits them at their level, with a JSON object no longer dropped (`#1558`, the relay in `backend-process.ts:46-64`; rejected alternatives are in `docs/architecture/logging.md:630-632`).
- **Updater logger.** `createUpdaterLibraryLogger` (`apps/desktop/electron/updater-log.ts:35`, set at `main.ts:781`, `#1558`) keeps the plan at `debug`.
- **Startup parse.** The listener is not detached, because it also relays, but `parseReadyMessage` returns early unless a line starts with `{` (`backend-process.ts:73`), which removes the thrown-and-caught cost the report named.

`docs/architecture/logging.md:634-635` records the rest as undecided and not built.

## Constraints and rationale

- The byte bounds and drop markers must not change.
- A log line must be one entry, so a chunk boundary must not split one.
- Quit must still flush what was accepted (`application-logging.ts:568-577`).

## Needs verification

- Whether a burst reaches the 4 MiB queue bound in practice. The logging report's 12.5k lines a day on one machine suggests rarely; not measured here.

## Related

- [Logging and database report, R7](../2026-10-29-logging-and-database-efficiency.md#r7-fix-the-electron-relay-and-file-writer-l6-l2) and [L6](../2026-10-29-logging-and-database-efficiency.md#l6-the-electron-relay-is-always-on-lossy-and-unbatched-medium)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 16 (DK-18)
- [2026-10-27 efficiency review, DK-18](../2026-10-27-efficiency.md)
