# Decide whether a bulk directory change becomes one row

From [efficiency report](../../reports/2026-10-29-logging-and-database-efficiency.md#r14-bound-measurement-file-rows-d1-highest-value) R14, part 0700 of batch E2, task 3 ("Collapse bulk directories"). The batch file was deleted when E2 was built; it is in Git history at base commit `e198fd4a7`.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`, with the E2 change applied.

### Tasks

1. **Re-check directory rows after the soak**: E2 took the report's recommendation not to add them now. Status: open (depends on [4960](4960-measurement-rows-live-soak.md) task 1).

### 1. Re-check directory rows after the soak

**Problem.** The report proposes one row per top-level directory when more than M files under it share a status. Without them a capped list of one bulk directory reads as up to 2,000 near-identical rows.

**Context.** The cap alone bounds the table, so this decides only how a capped list reads. Rows with text changes are kept first, then the rest by path, which helps but does not stop a bulk add of text files filling the list.

**Investigation.** A row's `path_id` identifies one file: `resolveLiveDetail` in `diff-bodies.ts` matches it, `restore.ts` filters by it, and `ChangeFileRow.rowId` encodes its ordinal. No row type represents a directory. In a 2,300-file real list on 2026-11-04 the source files sorted first and the bulk followed, as designed.

**Decisions.**

- **Add directory rows?**
  - **Not until the soak shows capped lists are common and read poorly (recommended).**
    - Pros: no new row kind for every reader and client; older clients keep working.
    - Cons: a list full of one directory keeps reading poorly up to the cap.
  - **Add them.**
    - Pros: a far better read of a bulk add or delete, and fewer rows.
    - Cons: per-directory line totals become approximate, and each reader needs a new case.

## Related

- [4960](4960-measurement-rows-live-soak.md)
- [Change tracking](../../architecture/change-tracking.md#retention-and-backup)
