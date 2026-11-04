# Terminal history loses the end of a fast burst

## Task analysis

Analysed 2026-11-04 against `main` at `a2827f52f`.

### Tasks

1. **Keep burst output in the terminal history archive**: a burst over 256 lines between flushes loses lines from the archive. Status: open.

### 1. Keep burst output in the terminal history archive

**Problem.** Found on 2026-11-04 while qualifying [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) on beelink. A command that prints more than 256 lines before the archive's queue drains loses the rest of those lines from terminal history, including the last ones. The terminal itself is unaffected: its state snapshot still holds the output.

**Context.** `enqueueHistoryRecord` in `apps/backend/src/core/terminal-history.ts` admits at most `TERMINAL_HISTORY_PENDING_RECORDS` (256) queued records per session and marks a gap when full. `flushPending` starts on a 250 ms timer and awaits an `appendFile` and a `chmod` for each record, so the queue drains slowly. The bound and the gap flag are deliberate: output may be dropped only under bounded backpressure, with an explicit signal. The history panel shows "Archive has a gap". What is open is how low the bound is for ordinary output.

**Investigation.** In the saved trace of `real browser gateway exercises an authoritative local environment`, a 1,100-line burst finished and the page read 17 ms later had 258 rows, `historyGap: true` and no final line. The spec no longer depends on this; see flake [2401](../../tests/flaky-tests/previews-annotations-and-gateway/2401-browser-smoke-terminal-history-marker.md). Nothing here measured how often real commands hit the bound, or how much faster a batched write would drain.

**Decisions.**

- **How should the archive handle a burst?**
  - **Write each flush's records in one `appendFile` per segment, then re-measure before changing the bound (recommended).**
    - Pros: drains the queue faster without holding more in memory; keeps every existing bound.
    - Cons: a burst inside one 250 ms flush window still stops at 256 lines unless the timer also changes.
  - **Raise the record bound and rely on the existing 1 MiB per-session byte bound.**
    - Pros: one constant; a burst of short lines is kept.
    - Cons: holds more in memory per session and across sessions; the global bound of 4,096 records would need checking with it.
  - **Leave it as it is.**
    - Pros: no change; the loss is already reported to the user.
    - Cons: the last lines of a long command's output, usually the ones wanted, are the ones lost.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found this.

## Assumptions and decisions

### Task 1: Review metadata layout (2026-11-04)

Moved the qualification provenance into the Problem paragraph so Task analysis
is the first section. Task scope and evidence are unchanged.
