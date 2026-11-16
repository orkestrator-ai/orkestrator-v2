# Decide whether a newly established worktree watcher's hint should force a rescan

## Task analysis

Analysed 2026-11-16 against `main` at `c1fcc573b`.

### Tasks

1. **Decide whether the establishing watcher's no-path hint should invalidate a scan that started after watching began.** Status: open.

### 1. Decide whether the establishing watcher's no-path hint should invalidate a scan that started after watching began

**Problem.** When a local environment starts being tracked, the diff-stats
service starts its watcher and its first scan together. Flake case 2404's
2026-11-15 instrumentation showed a watcher hint with no paths arriving while
that first scan was still running. The hint advances the entry's
`dirtyEpoch`, so the first scan's file list is stale the moment it lands and
the service scans the worktree a second time. If that hint can never carry a
change the first scan missed, the second `git status` is wasted work on every
track (every environment start, resume and backend start).

**Context.** `apps/backend/src/core/diff-stats-service.ts`: `request()`
advances `dirtyEpoch` on every `hint`; a scan records the epoch it started at
and a read requires a result at least that new, so any hint during a scan
queues one rerun. The local watcher is `apps/backend/src/core/worktree-watcher.ts`:
the tree watch is established synchronously, Git metadata coverage arrives
later through `resolveGitPaths`, and `noteDelivery` sends a no-path
`onChange()` when trust returns after a distrusted period. Which of these
paths sent the observed hint was not recorded. This question was left open by
to-do 8302 (retired 2026-11-16), which added `DiffStatsService.fileListCurrency`
so that the Files-panel test no longer depends on the answer (case 2404,
"Resolution (2026-11-16)").

**Investigation.** Not started beyond the case 2404 evidence: under
`scripts/test-under-contention.ts --burners 6` the hint arrived about 2 s
before the first scan settled and moved the epoch from 1 to 2. Whether the
hint also appears on an idle host, and which watcher path sends it, is
unknown. The cost is one extra scan per track, bounded by
`LOCAL_SCAN_MIN_GAP_MS` only when the hint is not urgent.

**Decisions.**

- **What to do about the establishing hint?**
  - **Measure first, then decide (recommended).** Record, with temporary
    instrumentation or a debug log line, which watcher path sends the hint
    and whether it carries any change the first scan missed, on an idle and
    a loaded host; change nothing unless it is provably redundant.
    - Pros: no risk of losing a real file change; the evidence also tells
      whether the extra scan matters at all.
    - Cons: one more investigation step before any saving.
  - **Ignore a no-path hint that arrives before the first scan started after
    the watcher was established.**
    - Pros: saves one `git status` per track.
    - Cons: a hint that did carry a change made between the watcher starting
      and the scan reading that path would be lost; the 400 ms settle and the
      metadata watch make that window hard to reason about without the
      measurement above.
  - **Leave it as it is.**
    - Pros: correct by construction; costs one scan per track.
    - Cons: the extra scan stays, and under contention it is what made the
      Files panel rescan.

## Related

- Flake case [2404](../../tests/flaky-tests/backend-services-and-tooling/2404-files-panel-scan-under-load.md) (resolved 2026-11-16).
- [git-scan-caches.md](../../architecture/git-scan-caches.md) for the watcher's coverage and the minimum scan gap.
