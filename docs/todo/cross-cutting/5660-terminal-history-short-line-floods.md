# Terminal history still overflows on floods of very short lines

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5` plus the change that closed to-do 4223.

### Tasks

1. **Keep a flood of very short lines in the terminal history archive**: tens of thousands of short lines in a few event-loop turns still overflow the archive's queue. Status: open.

### 1. Keep a flood of very short lines in the terminal history archive

**Problem.** `seq 1 20000` in a real terminal kept 15,423 of its 20,004 rows and lost its last lines, with the gap reported. `seq 1 100000` kept 49,154 rows and also lost its last line. The terminal's own state snapshot is unaffected.

**Context.** `enqueueHistoryRecord` in `apps/backend/src/core/terminal-history.ts` turns output into one queued record per line. A queued record costs about 73 bytes beyond its text, and the queue charges 80 per record against its 1 MiB per-session bound, so at most 12,288 lines fit, fewer as they lengthen. A PTY chunk is queued whole in one event-loop turn, before any write can free space, so a chunk of very short lines uses much of the queue on its own. Ordinary output is not affected: the same real-terminal run kept all of 100,000 lines of 78 characters with no gap.

**Investigation.** Measured on a loaded host (load average about 30) in an isolated profile. The cases that lost lines were `seq` runs, around 5 bytes a line; `seq 1 5000` kept every line. How much of the loss depends on host load was not separated, and nothing here measured how often real commands produce this shape. Which rows survive also varies: an earlier `seq 1 100000` run, with a charge of 128 bytes per record, kept 55,594 rows including its last line.

**Decisions.**

- **How should the archive hold a flood of short lines?**
  - **Queue raw output and split it into lines when writing (recommended).**
    - Pros: a queued line then costs nothing beyond its text, so 1 MiB holds about 190,000 lines of `seq` output; the existing byte bound stays the limit.
    - Cons: the sanitizer, line carry and sequence numbers move to the write side, and checkpoints and pages read `session.sequence` before that write has run, so those reads need rework.
  - **Raise byte and record bounds together.**
    - Pros: retains the existing record queue and write path.
    - Cons: more memory per session and across sessions for every session, to serve a rare shape; 20,000 lines of `seq` would need about 1.6 MiB, a per-session record cap above 20,000, and corresponding increases to the global byte and record bounds. Raising only the byte bound still stops at 12,288 queued records.
  - **Leave it as it is.**
    - Pros: no change; the loss is reported to the user and the state snapshot keeps the end of the output.
    - Cons: the last lines of such a command are the ones lost from the archive.

## Related

- Flake [2401](../../tests/flaky-tests/previews-annotations-and-gateway/2401-browser-smoke-terminal-history-marker.md), whose burst of 1,100 long lines the archive now keeps.

## Assumptions and decisions

### Task 1: capacity option accuracy

The follow-up remains open. Its alternative now raises the independent per-session and global record bounds alongside the byte bounds: increasing bytes alone cannot admit a 20,000-line burst past the 12,288-record cap. The recommended raw-output approach is unchanged.
