# Does a real log burst reach the file writer's 4 MiB queue bound?

## Task analysis

Analysed 2026-11-05 against `main` at `e1f4c875f`.

### Tasks

1. **Look for drops in real saved logs**: find out whether the log file writer's in-memory queue fills in normal use. Status: open.

### 1. Look for drops in real saved logs

**Problem.** The log file writer drops entries once 4 MiB (or 65,536 entries) are queued and not yet written. Nobody knows whether a real burst ever gets there.

**Context.** From efficiency report part `0860` (E26), its "Needs verification: whether a burst reaches the 4 MiB queue bound in practice". The writer is `installProductionApplicationLogging` in `packages/protocol/src/node/application-logging.ts`; DK-18 batched its appends on 2026-11-04 ([1202](1202-efficiency-review-follow-ups.md) task 16), which makes the bound harder to reach than when the report was written. The logging report's sample was 12.5k lines in a day on one machine, which suggests rarely. This build could not answer it: the answer needs saved logs from real use, and this work ran only on disposable profiles.

**Investigation.** The writer already records every drop in the file itself: the next entry that fits is preceded by a `warn` line, area `logging`, event `entries.dropped`, with `entries` and `bytes` fields (`dropMarker` in `application-logging.ts`). So a search of saved log files answers the question without new code. Saved logs exist only where Save Logs to Disk is on.

**Decisions.**

- **How to find out?**
  - **Search the maintainers' saved logs for `entries.dropped` after a week of normal use with Save Logs to Disk on (recommended).**
    - Pros: no code; uses the marker the writer already writes; real workloads.
    - Cons: needs saving turned on for a week, and covers only the machines that look.
  - **Add a drop counter to the health or metrics surface.**
    - Pros: visible without saved logs, on every install.
    - Cons: new code for a question the existing marker can answer; the health row is still open work (efficiency report part `0820`).
  - **Leave it.**
    - Pros: nothing to do; a drop is already recorded where it happens.
    - Cons: a bound that is hit often would go unnoticed until someone reads a log.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 16 (DK-18).
- Closing check of E26 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which records the outcome of report part `0860`.
- [The file writer](../../architecture/logging.md#the-file-writer).
