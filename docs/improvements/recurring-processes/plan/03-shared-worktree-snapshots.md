# 03 — Share worktree snapshots across diff and file readers

Status: Implemented (backend owner, protocol, Files panel migration, unit and
real-Git coverage); real-browser, Docker and live-profile qualification remain
for step 12 — see [Completion notes](#completion-notes). Dependencies: 01, 02;
step 11 contract before event-led polling reduction. Findings: F01, F04, F07.

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

## Completion notes

Recorded 2026-09-25 on branch `worktree-agent-aa757439a243bac3f` (based on the
wave-1 foundation merge `7b93c83e`). Commits: `597de2f8` (backend owner,
protocol, watcher), `a9cb5d73` (Files panel), `06cde4db` (harness scenarios
and step 03 artifact), then the step 04 baseline hook plus this note and the
architecture/baseline docs.

### What landed

**One read owner per scan identity (tasks 1–3).** `DiffStatsService`
(`apps/backend/src/core/diff-stats-service.ts`) is the owner. A tracked
identity is the service `generation` (UUID per backend lifetime), the
environment's `targetGeneration` (service-unique lineage: canonical worktree
path or container, comparison ref; new on retarget, resume from pause and
re-track) and the working-tree option. `readFileList({ lookup, comparisonRef,
includeUncommitted, refresh })` and `readTree({ lookup, refresh })` serve the
sidebar's background scans and every client's Files panel from the same
scan/walk. Other identities (committed-only lists, another ref, an untracked
or paused target) go to `AdhocWorktreeReads` (`worktree-adhoc-reads.ts`):
equal concurrent reads join, distinct options never share, nothing is cached.
Command response shapes are unchanged (raw array without `knownDigest`,
`{ unchanged, digest, value? }` with it, same digest function); an additive
`view` stamp and `refresh` flag were added.

Freshness is an epoch, not an age: hints, known mutations and explicit
refreshes advance `dirtyEpoch`; a scan records its start epoch; a read needs a
result at least as new as the epoch when it arrived, so it can join a scan
already running since the last change, and a `refresh` advances the epoch
first and therefore waits for a post-click scan. Publication is fenced by
target lineage and `mutationGeneration` (scans and walks that began before a
mutation, retarget, pause or untrack never publish). `adoptScan`,
`cachedChanges` and `readSharedFileList` are removed.

**Revisions (tasks 4–5).** `semanticFileListDigest`
(`worktree-snapshot-digest.ts`) covers path, original path, status,
additions, deletions and truncation in canonical order; `fileListRevision`
advances on it independently of the aggregate counts (a same-count,
different-path list advances; an identical rescan does not). The wire digest
stays `sha256(JSON.stringify(value))`, computed once per result. Content
invalidation decision: **not provided.** The file-list revision is not a
content revision (an edit keeping path/status/line counts does not advance
it); open editor tabs keep their existing load-on-open behaviour
(`FileViewerTab`), and a future content invalidation would need a per-path
content digest. `WorktreeTreeSnapshots` (`worktree-tree-snapshots.ts`) owns
the tree separately: own `treeRevision` (advances on tree digest change),
cache bounded to 32 bodies / 16 MiB / 4 MiB per body (LRU by last read; an
evicted or unretained body keeps its digest and revision), existing 5,000-node
walk bounds unchanged, re-walk on a tree-relevant hint only while a client read
it in the last 60 s.

**Watching (tasks 6–7).** `startWorktreeWatcher` reports settled bursts as
`{ fileList, tree, overflow }` hints (400 ms settle retained). It resolves a
linked worktree's Git dir and common dir from the `.git` pointer and
`commondir` (`worktree-git-paths.ts`, no process spawn) and watches the
per-worktree Git dir (`index`, `HEAD`), the common dir (`packed-refs`) and
`refs/` recursively, filtered to the refs `resolveLocalGitBase` can resolve
the comparison through (Git's DWIM expansions of `origin/<ref>` and `<ref>`;
none for a full SHA). It is `qualified` only once that coverage exists; until
then, and for containers or after watcher failure, results are age-bounded
(3 s). Ignored as proven noise: `.git` locks, objects, logs, `FETCH_HEAD`,
other branches; `node_modules` and `.git` are ignored for the tree only (the
file list still reacts, since build directories can hold tracked or visible
untracked files). Index mtime/HEAD are never used as proof of no change. A
null filename or a burst over 10,000 events dirties both views. The 120 s
safety scan and 15 s unwatched poll remain. Bounds: one pending hint per
watcher, epochs are counters, ad hoc joins exist only while in flight;
directory coverage is the recursive root watch plus at most three metadata
watches — OS watch limits surface as watcher errors (fallback below), not as
silent loss.

**Admission, retries, freshness (task 8).** Scans and walks run through the
shared `gitDockerScanPool` (`git-docker-scan-pool.ts`; 4 total, 1 per target;
walks use a separate `#tree` target so they do not queue behind the same
target's Git scan; ad hoc reads share the scan target, so they serialize with
the owner's scan). Priorities: reads/refresh `interactive`, hints/reruns
`progress`, track/periodic/retry `discovery`. Periodic ticks never queue a
rerun behind a running scan, are skipped while a failure backs off, and are
skipped when any scan started within half an interval (a container's Files
panel read already refreshed the counts). Only genuine changes (hint,
mutation, refresh, retarget) queue the single rerun. Failures keep the last
good list and counts with `freshness` `stale` (or `failed` with no good
result), rethrow to readers during the backoff (5 s doubling to 60 s, 5 timed
retries per streak; explicit refresh bypasses). Watcher failure falls back to
the 15 s poll and re-attaches with capped backoff (30 s doubling to 10 min, 5
attempts per lineage); a successful re-attach rescans once for the outage.

**Events and the Files panel (task 9).** Additive protocol
(`packages/protocol/src/worktree-snapshots.ts`): event
`worktree-snapshot-changed` (per-environment `{ targetGeneration,
comparisonRef, fileListRevision, treeRevision, freshness, watched }` or a
removal, stamped with the service generation and its own contiguous revision)
and command `get_worktree_snapshot_revisions` (step 11 conditional reads). The
snapshot serves announced state only. `useWorktreeSnapshotRevisions` hydrates
it while the panel is open (bounded hydration, subscribe before snapshot,
reconnect and resource-sync safety checks); `useFilesPanel` re-reads exactly
the view whose announced revision is newer than the stamp of what it shows (or
whose owner generation/lineage differs), skips this while the document is
hidden (the read coordinator reconciles on return), passes `refresh: true` on
manual refresh, and keeps the post-mutation double read. The 5 s coordinated
poll stays for every peer: it is the only trigger for legacy/unsupported
backends and unwatched targets, and for a quiet watched worktree the backend
answers it from valid watched state.

**Lifecycle (task 10).** Pause keeps the counts, drops the file list and tree,
releases watcher, interval, retry timers and any queued admission wait, and
fences the running scan; resume starts a new lineage. Untrack additionally
announces removals. Late scans cannot resurrect a list, counts or revision.

### Hook for step 04 (container fetch policy)

When a fetch moves a container's (or worktree's) comparison base outside a
watched path, call `diffStatsService.invalidateBaseline({ containerId })` (or
`{ worktreePath }`) from `commands-runtime-state.ts`'s singleton. It advances
the target's dirty epoch and requests one scan (joining/following a running
scan, which is not fenced — it is an older observation, not a wrong one);
readers after the call wait for the post-fetch scan, and the file-list
revision advances only if the list actually changed. Do not use
`invalidateChanges` for fetches: it is the workspace-mutation fence and also
dirties the tree. Local worktrees need nothing extra: a fetch that moves
`refs/remotes/origin/<ref>` or `packed-refs` is already a watcher hint. When
the status script stops fetching, step 04 should keep scans inside
`gitDockerScanPool` and run its own fetches ahead of it in acquisition order
(or in the same pool under the target key) so a fetch and a scan of one
container never overlap.

### Measured before/after (deterministic harness)

`step-03-snapshots.json`, compared with `step-01-baseline.json`; full table
in [the baseline README](../baseline/README.md#step-03--shared-worktree-snapshots-after).
Ten-minute warm idle, one Files panel on environment 0:

- Local, one client (`env1-local-c1`): 120 → 5 physical status scans, 120 →
  0 tree walks, `git` spawns 60.2 → 2.6/min, `readdir` 480 → 0/min (identical
  to no client). Two clients (`env10-mixed-c2`): `git` 130.7 → 15.6/min,
  `readdir` 960 → 0/min.
- Container, one client: unchanged (84 execs/min; each 5 s read still needs a
  ≤3 s result, and the periodic scan is skipped instead). Two clients
  (`env1-container-c2`, new): one scan and one walk per tick for both.
- Scenarios without a client: identical counters.

Metric semantics changed with ownership: tracked Files-panel reads now count
`requested`/`cacheHits`/`coalesced`/`cacheMisses` under `file-list-read`, and
their physical scans are charged once to `diff-scan`; `file-list-read`
`started` counts only ad hoc physical reads. `file-tree-read` `started` counts
physical walks. The catalogue marks both reads `join`.

### Tests

Owner (`apps/backend/src/core/worktree-snapshots.test.ts`, manual clock and
deferred scans): one physical scan for the background scan plus two clients,
and for a hint scan plus reads; distinct options/refs never share while equal
ad hoc reads join; 46 five-second quiet reads of a watched worktree over two
minutes with no scan, then the safety scan; same counts/different paths
advances the file-list revision; identical rescans announce nothing;
truncation alone advances; tree-only change without a Git scan; tree hint
without readers only marks dirty; lost event recovered by a conditional read
(consumed revision); backend restart resets by generation; baseline moved by a
fetch (`invalidateBaseline`); mutation during a read rejects the stale
publication; explicit list and tree refresh wait for post-click work; periodic
ticks during a slow scan queue nothing while a genuine change queues one;
missing ref (failed freshness, throttled reads, refresh retries); permission
error keeps last good with stale freshness and caps retries; watcher creation
failure, error and overflow fallback with retry and one outage rescan;
unqualified coverage stays age-bounded; baseline retarget and container
replacement fence the old lineage; pause/untrack release watcher, timers,
retries and queued admission and cannot be resurrected; admission bound and
per-target serialization; large-tree non-retention and LRU eviction without
revision rewind. Real Git (`worktree-snapshots-git.test.ts`, real linked
worktree, real watcher, no `origin` so every fetch fails): a tracked edit that
never touches the index, staging whose index lives outside the root, and a
shared ref moving the baseline are each detected by watcher hints alone.
Watcher/paths (`tests/unit/backend/worktree-watcher.test.ts`): change
classification, linked-worktree metadata coverage and qualification, metadata
watch failure, main-checkout coverage, burst overflow, real `.git`
resolution. Existing diff-stats, view-revision and metrics suites were updated
for the removed cache API. Protocol: `worktree-snapshots.test.ts`. Web:
`useWorktreeSnapshotRevisions.test.tsx` (subscribe before hydrate,
generation, invalid payloads, removal, unsupported, disabled, identical
rehydrate), `useFilesPanel.snapshots.test.tsx` (announced list/tree
revisions re-read once, duplicates read nothing, lineage change, hidden
document, manual refresh flag, legacy backend polling only, unchanged reads
do not rewrite the store), and the wrapper test for the stamp and flag.

Recovery coverage rows this view adds (step 11 list): event before
subscription / during snapshot / gap / generation reset / overflow / invalid
payload / unsupported rely on `bounded-hydration.test.ts` plus
`useWorktreeSnapshotRevisions.test.tsx`; lost final event → worktree-snapshots
› "the revision view answers conditional reads and survives a lost event";
same-count path change → "same counts with different paths…"; tree-only edit
→ "a tree-only change is visible without a Git scan"; unavailable is not
empty → "a missing ref fails the read…" and "a permission error keeps the
last good list…".

### Checks

- Focused suites above: all pass (the real-Git file three times in a row).
- `mise run test:logged -- --name check -- mise run check`: pass.
- Baseline harness `--compare`: 226 differing counters, all in client
  scenarios (as tabulated); `apps/backend/tests/recurring-baseline.test.ts`
  passes.
- `mise run test:changed` (at `06cde4db`; the later `invalidateBaseline`
  commit was verified with its focused suite): root/agent-support (99 s),
  bridges and codex lockfile groups pass; workspace group 7,309 pass / 11
  skip / 1 fail. The failure, `DesignCanvasTab history › only the focused
  pane handles a shared shortcut`, imports no changed code, passes when its
  file is rerun alone (4/4), and was already seen failing only under load in
  step 11's notes. No flake-index entry was added.

### Not done / untested constraints

- No real-browser, Electron or Docker qualification: the isolated `dev:test`
  profile (inactive-environment switch, two windows, hidden document, reload,
  missed final invalidation, container fixture) was not run; measured
  change-to-visible latency was not recorded. Headless unit coverage only.
- Container Files-panel cost is unchanged for one client; reducing it needs
  step 04 (fetch out of the status script) and a trial of a longer unwatched
  bound, which this step did not change.
- A read that joins a scan still queued for admission at `discovery` does not
  raise its priority (the pool has no re-prioritisation); scans rarely queue
  at the default limits.
- The Files panel still polls every 5 s (cheap now); no client cadence was
  reduced. `RecurringScheduler` was not adopted here: per-entry interval
  timers were kept (their tests and harness seams are unchanged) and the
  admission pool supplies the global bound.
- Watch coverage on platforms without recursive `fs.watch` is the documented
  polling fallback; only Linux was exercised.
- Other clients (e.g. iOS) are unaffected by the additive fields but do not
  use the revisions.
