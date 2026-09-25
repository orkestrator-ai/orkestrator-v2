# 03 — Share worktree snapshots across diff and file readers

Status: Not started. Dependencies: 01, 02; step 11 contract before event-led
polling reduction. Findings: F01, F04, F07.

## Outcome

For an equivalent target and baseline, foreground file readers and background
diff statistics join one scan. A quiet watched worktree avoids repeated full
scans/tree walks while still recovering missed watcher events. File-list and
tree changes are observable even when aggregate counts remain identical.

## Existing targets

- `apps/backend/src/core/diff-stats-service.ts` and `worktree-watcher.ts`.
- `commands-runtime-state.ts`, `commands-registry-terminal.ts`, `commands-files.ts`.
- `packages/protocol/src/diff-stats.ts` and an additive file-snapshot contract.
- `apps/web/src/hooks/useFilesPanel.ts`, `useEnvironmentDiffStats.ts` and their stores.
- `tests/unit/backend/diff-stats-service.test.ts`, `worktree-watcher.test.ts`,
  `apps/web/src/hooks/useFilesPanel.test.tsx` and command-level file tests.

## Implementation tasks

1. Specify scan identity: backend generation, environment execution identity,
   canonical worktree/container generation, comparison ref, resolved base when
   necessary, and options such as inclusion of uncommitted changes. Counts and
   a request for committed-only changes must not accidentally share results.
2. Add an asynchronous read method to the backend owner that can return a current
   cached snapshot or await/join a scan. Route both status commands and background
   scans through it. Preserve old command response shapes through adapters until
   capability negotiation enables richer revisions.
3. Capture a mutation/target generation before scanning and check it before
   publication. Remove unfenced external `adoptScan` usage or require the captured
   generation. A manual refresh during an old scan must wait for one newer pass,
   not return the old in-flight result as if it honored the click.
4. Define a semantic digest/revision for full changed-file entries, including
   path/original path, status, additions/deletions and truncation semantics.
   Advance it independently of aggregate counts. Explicitly decide whether file
   content changes with identical metadata need a separate content invalidation
   for an open editor; do not overload the file-list revision to promise this.
5. Add a separate tree snapshot owner with bounded entry/byte cache and a tree
   revision. Tree membership and Git changes are different: empty folders and
   ignored files can affect the displayed tree without affecting Git status.
   Route repeated tree reads through this owner and retain existing bounds.
6. Treat watcher events as invalidation hints. Watch the worktree and relevant
   resolved Git metadata where needed: a linked worktree's `.git` is a pointer,
   and shared refs can change outside the watched root. Resolve these paths
   through repository helpers; never assume `.git/index` lies below the root.
   Keep fallback scans for missed events, changed refs and watcher failure.
7. Retain 400 ms burst coalescing initially. Ignore only proven irrelevant
   metadata noise. Do not use index mtime/HEAD alone as proof that working files
   are unchanged. Do not blindly ignore build directories that may hold tracked
   or visible untracked files. Bound queued invalidations and directory coverage.
8. Apply global admission from step 02 and per-target serialization. Separate
   periodic refresh from genuine dirty hints so slow scans do not create a
   permanent immediate-rerun loop. Retain last-good results on failure with
   explicit stale/failed freshness; add capped failure retry and watcher retry.
9. Publish generation/revision invalidations with authoritative snapshot APIs.
   Implement step 11 buffer/recovery guarantees. Update the Files panel to
   subscribe before hydration, join reads, fence target changes and request
   immediate post-mutation refresh. Retain polling for unsupported backends and
   unqualified watcher coverage.
10. Account for paused/stopped/deleted/retargeted environments. Release watchers,
    timers and read slots; preserve last-known counts where current behavior does.
    Invalidate file detail on pause and prevent late scans from resurrecting it.

## Required tests

Prove one physical scan for concurrent service + two-client reads; distinct
options do not share; five-second repeated quiet reads use valid watched state;
same counts/different paths advances file revision; tree-only change is visible;
mutation while read is in flight rejects stale publication; explicit refresh
waits for post-click state; watcher creation/error/overflow uses fallback; shared
ref and linked-worktree changes recover; a tracked edit does not touch index but
is detected; unchanged reads do not rewrite stores.

Also cover branch/baseline/container replacement, large/truncated trees, missing
refs, permission errors, remote-fetch failure, multiple clients, event loss,
backend restart, inactive environment and hidden-document return. Test scan count
and returned semantics, not the precise internal number of timer handles.

## Acceptance and rollback

Equivalent concurrent requests perform one physical scan, and the invalidation
path updates files even with unchanged badge counts. Quiet watched worktrees
perform no repeated foreground full scan merely because three seconds elapsed;
the configured safety scans remain. Measured visible freshness must meet the
baseline budget. Roll back client event reliance first, retaining shared reads
and conservative fallback; do not remove authoritative APIs during rollback.
