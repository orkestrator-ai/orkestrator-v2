# A write to Git-ignored output starts a provisional capture

From todo 4962 (retired 2026-11-11; in Git history at `14df96544`), whose churn
measurement is in [Change tracking: provisional capture churn](../../architecture/change-tracking.md#provisional-capture-churn-2026-11-11).

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Skip a provisional capture whose hint names only Git-ignored paths**: decide whether to filter such hints before capturing, and build it if so. Status: open.

### 1. Skip a provisional capture whose hint names only Git-ignored paths

**Problem.** In the 4962 measurement half of all provisional captures found
the tree they had already published (9 of 17 at one tool call every 1.5 s, 12
of 24 at one every 0.5 s). Every one followed a write only to Git-ignored
output (`dist/`, `coverage/`, `node_modules/.cache/`), the kind a test run or a
build leaves behind. The no-change skip stops them writing measurement rows,
but each still costs a full warm capture and a snapshot row that retention
later removes. A warm capture costs 13 ms to 1.2 s depending on repository size
and host ([Change tracking: benchmarks](../../architecture/change-tracking.md#benchmarks)),
so on a large repository every test run costs about a
second of capture work that cannot change anything.

**Context.** `classifyWorktreeChange` (`worktree-watcher.ts`) lets every
non-`.git` path through for the file list on purpose, because a build
directory can still hold tracked or visible untracked files, and leaves out only
`node_modules` from the tree. The diff scan forwards each settled hint, with
its paths when there were at most `WATCH_HINT_MAX_PATHS`, to
`ChangeTrackingService.noteWorktreeActivity`, which starts
`TurnBoundaryService.provisional` whatever the paths are. A host capture
inventories tracked files (`git ls-files -s`) and untracked files Git does not
ignore (`git ls-files --others --exclude-standard`), plus the paths the previous
manifest covered (`CaptureRequest.previous`). So a hint whose every path is
untracked, ignored and absent from the previous manifest cannot move the
captured tree. A `.gitignore` or `.git/info/exclude` change can, and those are
not ignored paths themselves. Container hints carry no paths, so this only
helps local environments.

**Investigation.** Measured with `bun scripts/benchmark-change-tracking.ts
--only=capture-churn` on beelink2 on 2026-11-11 (method and table in
[Change tracking](../../architecture/change-tracking.md#provisional-capture-churn-2026-11-11)).
The measurement did not time the wasted captures, and it ran on a 200-file
repository. `git status` caused one unchanged capture in eight calls (an index
refresh), `git diff` and reads none. Not built or prototyped.

**Decisions.**

- **Filter ignored-only hints before capturing?**
  - **Check a hint's paths with one `git check-ignore` call and skip the capture when all are ignored and none is in the latest manifest; any hint without paths still captures (recommended).**
    - Pros: one short Git process instead of a capture with three, a stat walk and a snapshot row; Git's own ignore rules, so nothing to keep in step; unknown-path hints keep today's behaviour.
    - Cons: a Git process per hint, and a hint mixing ignored and visible paths still captures; needs care so a `.gitignore` edit is never filtered.
  - **Keep an in-process ignore matcher per worktree.**
    - Pros: no process at all per hint.
    - Cons: re-implements Git's ignore semantics (nested `.gitignore`, global excludes, `core.excludesFile`), which can drift from what the capture's `ls-files` sees.
  - **Leave it.**
    - Pros: no change; the no-change skip already keeps the ledger bounded.
    - Cons: every test run or build during a turn costs a capture that cannot change anything.

## Constraints and rationale

The filter may only skip work: it must never stop a capture that could move
the tree. When in doubt (no paths, an overflowing burst, a failed
`check-ignore`, a container) it captures, as today. The turn's end capture is
never filtered.

## Related

- [7560](7560-large-ignored-trees-in-the-worktree-watch.md): the watch plan's own handling of large ignored trees.
- [Change tracking: turn and thread boundaries](../../architecture/change-tracking.md#turn-and-thread-boundaries)
