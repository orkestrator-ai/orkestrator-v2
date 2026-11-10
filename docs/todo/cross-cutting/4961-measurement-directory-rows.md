# Decide whether a bulk directory change becomes one row

From efficiency report (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`) R14, part 0700 of batch E2, task 3 ("Collapse bulk directories"). The batch file was deleted when E2 was built; it is in Git history at base commit `e198fd4a7`.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the E2 change applied. Task 1's dependency re-checked 2026-11-10 against `main` at `c98b20e6f`: the 4960 soak it waited on is done.

### Tasks

1. **Re-check directory rows after the soak**: E2 took the report's recommendation not to add them now. Status: open (the 4960 soak is done, 2026-11-10; what it measured is under Investigation, and the decision is left to make).

### 1. Re-check directory rows after the soak

**Problem.** The report proposes one row per top-level directory when more than M files under it share a status. Without them a capped list of one bulk directory reads as up to 2,000 near-identical rows.

**Context.** The cap alone bounds the table, so this decides only how a capped list reads. Rows with text changes are kept first, then the rest by path, which helps but does not stop a bulk add of text files filling the list.

**Investigation.** A row's `path_id` identifies one file: `resolveLiveDetail` in `diff-bodies.ts` matches it, `restore.ts` filters by it, and `ChangeFileRow.rowId` encodes its ordinal. No row type represents a directory. In a 2,300-file real list on 2026-11-04 the source files sorted first and the bulk followed, as designed.

The 4960 busy soak on 2026-11-10 ([Change tracking: busy live soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)), whose workload writes one bulk directory per environment and per held turn, answers the "common" half: past the cap lists were common (237 of 1,129 measurements at the end, 272 of 928 at the peak), and capped turn lists made up most of the ledger, since a finished turn keeps its list for the 30-day window (about 2,000 rows, 0.5 MiB, per bulk turn). One directory row per bulk directory would cut those to a handful of rows. It does not answer whether a capped list reads poorly; that is a judgement on the Changes view, and the soak drove no reader of a capped list. So the decision below is now a trade between that storage and a new row kind, rather than waiting on a measurement.

**Decisions.**

- **Add directory rows?**
  - **Not until the soak shows capped lists are common and read poorly (recommended).**
    - Pros: no new row kind for every reader and client; older clients keep working.
    - Cons: a list full of one directory keeps reading poorly up to the cap.
  - **Add them.**
    - Pros: a far better read of a bulk add or delete, and fewer rows.
    - Cons: per-directory line totals become approximate, and each reader needs a new case.

## Related

- 4960 (retired 2026-11-10): the soak, now in [Change tracking: busy live soak](../../architecture/change-tracking.md#busy-live-soak-of-the-row-cap-2026-11-10)
- [Change tracking](../../architecture/change-tracking.md#retention-and-backup)
