# Untracked files are re-read on every scan

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stat-keyed line count cache**: skip reading an untracked file whose stamp has not changed. Status: open.
2. **Bounded concurrency in Git scopes**: count untracked files concurrently there too. Status: open.

### 1. Stat-keyed line count cache

**Problem.** Each scan opens and reads every untracked file to count its lines, with no memory of the last answer.

**Context.** The report's fix is a per-worktree cache from `(ino, size, mtime, ctime)` to the count.

**Investigation.** `getLocalGitStatusDetailed` counts every untracked path through `countLocalFileLinesDetailed` (`apps/backend/src/core/commands-files.ts:1078-1082`, `:1158`). ST-1 settled the equivalent question for captures: a matching stamp is trusted only once the file's times were at least 2 s old when read (`STAT_SETTLE_WINDOW_MS`, `apps/backend/src/core/change-tracking/capture.ts:95`), because a same-size rewrite within one timestamp tick keeps the stamp.

**Decisions.**

- **When may a matching stamp stand in for a count?**
  - **Only once settled, using the rule ST-1 already uses (recommended).**
    - Pros: closes the racy same-size rewrite; one rule in the codebase.
    - Cons: a file being written is recounted until it ages.
  - **Trust any matching stamp.**
    - Pros: simplest; skips the most reads.
    - Cons: a racy rewrite shows a wrong count until the next write. The count is shown to users.

### 2. Bounded concurrency in Git scopes

**Problem.** Git scopes count up to 2,000 untracked files strictly one at a time.

**Context.** The scan path already bounds this with `mapWithConcurrency`.

**Investigation.** `apps/backend/src/core/change-tracking/git-scopes.ts:389-396` awaits each count inside a `for` loop. `mapWithConcurrency` is exported at `commands-files.ts:1117`, and that file is already imported there for `countLocalFileLinesDetailed` (`git-scopes.ts:38`).

**Decisions.** None: use `mapWithConcurrency`. The loop's `ambiguous-index-membership` reason must still be recorded per listed path.

## Constraints and rationale

The report's [invariant](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) that every cache has byte and count bounds applies. `UNTRACKED_SCAN_MAX_FILES` still reports its cap rather than applying it silently.

## Needs verification

- How often worktrees hold enough untracked files for this to show; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
- [ST-14](0440-st-14-git-scan-processes.md)
