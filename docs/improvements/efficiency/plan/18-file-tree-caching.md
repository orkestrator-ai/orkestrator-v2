# 18 — Cache file trees with watcher and TTL reconciliation

Status: Implemented, validation pending (cached values/digests, request
sharing and watcher integration in `0ba8628e`; container/ad hoc residuals
recorded below). Prerequisite: 01. Finding: E12.

## Outcome

Unchanged tree reads return a cached digest without enumerating, sorting, or
launching a container process again. Filesystem changes still become visible
when watchers are unavailable, miss events, or restart.

## Owners

- [Tree commands](../../../../apps/backend/src/core/commands-registry-terminal.ts).
- [Enumeration and parsing](../../../../apps/backend/src/core/commands-files.ts).
- [Conditional response helper](../../../../apps/backend/src/core/commands-terminal.ts).
- [Worktree watcher](../../../../apps/backend/src/core/worktree-watcher.ts).
- [Files hook](../../../../apps/web/src/hooks/useFilesPanel.ts) and command tests.

## Implementation

1. Extract a file-tree snapshot service keyed by canonical root/environment,
   container identity/generation where applicable, exclusion-policy version,
   and tree options. Cache tree value, digest, measured size, observed watcher
   revision, validation time, and one in-flight scan.
2. Keep the 5,000-node cap, ignored directories, symlink/path validation, sorting,
   and malformed-output handling. Add explicit cache entry/byte limits and
   bounded scan concurrency so visiting many roots cannot retain every tree.
3. Share watcher ownership where existing lifecycle permits. Closing the files
   panel releases only its subscription, not a watcher still used by git badges
   or other views. Watchers remain backend-owned and are disposed when the root
   is retired or no owner requires them under a bounded retention policy.
4. Mark dirty on directory membership/rename/create/delete changes. Only skip
   content-only events when the event source proves they cannot affect tree
   shape. The current coarse watcher must conservatively invalidate for unknown
   events or missing filenames; a filename extension is not proof of event type.
5. Capture the dirty generation before scanning. If another invalidation lands
   during enumeration, publish the coherent result as bounded stale if allowed
   and schedule one trailing scan, or retry before claiming current. Do not clear
   a newer dirty generation when an older scan completes.
6. Explicit application file mutations invalidate their root synchronously and
   join/await a guaranteed post-mutation scan where the current UI expects one.
   A manual refresh forces reconciliation even when a watcher claims clean.
7. Keep TTL reconciliation. Start with the existing freshness behavior for
   unwatched roots; increasing TTL is a separate measured tradeoff. For local
   watched roots, a longer safety TTL may avoid most idle scans while still
   recovering missed events. Document both intervals and stale-response rules.
8. For containers without a persistent watcher, implement bounded TTL plus
   in-flight sharing first. This saves concurrent duplicate scans but does not
   eliminate one scan per freshness interval; report that limitation. Add a
   container watcher only after measuring whether its process/resource cost is
   justified, with restart/generation and overflow recovery specified.
9. Reuse the cached digest in conditional replies. Do not call the existing
   helper in a way that serializes the same cached tree again on every request.
   Failed reconciliation returns an explicit stale/unavailable result under the
   supported contract, never an authoritative empty tree.

## Tests

- Repeated reads and concurrent clients share one unchanged value/digest and
  one scan where due; count filesystem and Docker exec calls.
- Create, rename, delete, nested-directory move, rapid editor writes, and an
  application mutation while a scan is pending produce the correct new tree.
- Watcher cannot start, fails later, reports unknown filename, or misses an
  event: TTL/manual reconciliation catches up.
- Container restart reuses a logical environment ID but not the old generation
  cache. Root switch and exclusion-policy change also invalidate identity.
- Symlink/malformed traversal output and node-cap truncation retain existing
  behavior. Retired roots release watches, scans, and cached payloads.

## Delivery

Ship cached values/digests and request sharing, then watcher integration. Measure
watched local roots separately from TTL-only container roots. Preserve current
git-fetch scheduling; do not treat Git index/HEAD timestamps as proof that the
working tree or file tree is unchanged.

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: 0ba8628e (#852) shipped the base; the residuals
  below are the "perf(backend): cache container and ad hoc file trees" commit
  (PR pending).
Protocol or storage decisions: none. Wire digests are unchanged
  (sha256(JSON.stringify(tree))); in-memory caches only.
Tests and isolated profiles: backend unit suite (fakes + real Git); no
  isolated profile run.
Before/after measurements: deterministic operation counts (below).
Compatibility/migration result: no client change; older clients' knownDigest
  still answers `unchanged`.
Remaining limitations: see "Remaining limitations".
```

### Already shipped in `0ba8628e`

- Items 1, 3–7 and 9 for tracked environments:
  [`WorktreeTreeSnapshots`](../../../../apps/backend/src/core/worktree-tree-snapshots.ts)
  keeps one tree per environment (revision, digest, retained body with its
  size, walk epoch, watcher generation and qualification, one in-flight walk,
  failure backoff), bounded at 32 bodies / 16 MiB / 4 MiB per body with
  least-recently-read eviction that never rewinds a revision. Qualified watched
  roots stay valid until a tree hint, mutation, refresh or watcher replacement;
  otherwise reads are age-bounded. A walk records the dirty epoch it started
  at and a mutation generation, so an older walk never satisfies a newer read
  or publishes across a mutation; hints during a walk queue one rerun while
  demanded.
- Tree commands (`get_local_file_tree`, `get_file_tree` in
  [`commands-registry-terminal.ts`](../../../../apps/backend/src/core/commands-registry-terminal.ts))
  read through `DiffStatsService.readTree` and answer conditionally from the
  owner's precomputed digest (`snapshotResponse`), with no rehash per read.
  Mutation commands call `invalidateChanges` first; `refresh: true` forces a
  walk that starts after the call. Failures reject (the last good tree is kept
  by the client); an empty tree is never synthesized.
- The watcher stays backend-owned by `DiffStatsService` (shared with the file
  list and badges); `classifyWorktreeChange` conservatively marks the tree
  dirty for every non-`node_modules` event, missing filename or overflow
  (item 4), and the 120 s safety tick re-dirties watched trees.
- Enumeration (5,000-node cap, `.git`/`node_modules` pruning, symlink and
  malformed-output handling, sorting) is unchanged in `commands-files.ts`.

### Added in this change

- **Serialize once (item 9).** `measuredResponseDigest` in
  [`worktree-snapshot-digest.ts`](../../../../apps/backend/src/core/worktree-snapshot-digest.ts)
  derives the wire digest and the UTF-8 size from one `JSON.stringify`; tree
  walks (tracked and ad hoc) use it instead of stringifying twice.
  `responseDigest` is unchanged for the file-list callers.
- **Container trees (item 8).** `CONTAINER_TREE_MAX_AGE_MS = 10_000` in
  [`diff-stats-service.ts`](../../../../apps/backend/src/core/diff-stats-service.ts),
  passed explicitly from
  [`commands-runtime-state.ts`](../../../../apps/backend/src/core/commands-runtime-state.ts)
  and separate from the 3 s unwatched bound (`DIFF_CACHE_MAX_AGE_MS`), which
  local unwatched roots and ad hoc reads keep. The tradeoff: the earlier
  analysis (recurring-processes step 04) showed that with a 5 s poll any
  bound ≥ 5 s pushes change-to-visible past the 6 s Files-panel budget. So the
  longer bound only applies while a membership signal covers the container:
  the Files tab already reads the file list with the tree, and each container
  file-list scan now records `treeMembershipDigest` (paths, original paths,
  statuses, truncation; not line counts). When it changes, the tree is hinted
  at once, and a reading panel re-walks and gets the tree-revision
  announcement. Git-visible creates, deletes and renames (untracked files are
  listed individually by `--untracked-files=all`) therefore keep the budget
  plus one walk, while content-only edits no longer re-walk. The 10 s bound
  applies only while the entry's last file list is complete, recent (within
  10 s) and not followed by a failure; otherwise the tree falls back to 3 s.
  The poll tick no longer hints unwatched trees: each read past the bound
  re-walks anyway, so the tick only added walks. Watched trees keep the
  safety-tick hint. Manual refresh, application mutations
  (`invalidateChanges`), and container stop/start (`pause` releases the tree;
  `track` starts a new lineage) are unaffected by the bound. A replaced
  container is a retarget and gets a new lineage.
- **Ad hoc trees (items 1–2).**
  [`AdhocWorktreeReads`](../../../../apps/backend/src/core/worktree-adhoc-reads.ts)
  now keeps a small tree value cache: 8 entries, 8 MiB total, 4 MiB per entry,
  LRU, TTL = the 3 s unwatched bound (no signal covers these roots). Identity
  is the resolved root or container id plus `FILE_TREE_POLICY_VERSION` (the
  exclusions/cap/shape version); the tree commands take no other options.
  In-flight walks are still shared. `invalidateTarget` (the same mutation
  path) drops the value and fences a running walk so it answers its own
  readers but is never cached. `refresh` bypasses and drops the value. Failures
  reject and are not cached. Expired values are pruned on access. Tracking,
  retargeting, pausing or untracking a root drops its ad hoc tree, and
  `shutdown` clears the cache.
- **Identity (item 1).** Tracked owners re-`register` on every retarget
  (root switch, replaced container) and resume (restarted container, even
  with the same id), which discards the body, fences the walk and restarts the
  revision. The exclusion policy is compiled in, so it cannot change under a
  live owner; a backend restart is a new owner generation.

### Tests

[`worktree-tree-cache.test.ts`](../../../../apps/backend/src/core/worktree-tree-cache.test.ts)
(new, 16 tests) adds the step's missing cases. They count walks
(filesystem/`docker exec` stand-ins) and scans:

- Quiet container panel (tree + list every 5 s for 60 s): **12 → 4 tree
  walks/min**, with file-list scans unchanged (12/min). The before figure uses
  the old 3 s bound.
- A Git-visible create re-walks on the next list scan and advances the
  announced tree revision; a content-only edit does not re-walk.
- A truncated list or a failing scan keeps the short bound (a walk per poll).
- Manual refresh bypasses a valid cache. A mutation during a pending walk
  yields the post-mutation tree for both readers.
- Container restart (same id and environment id) walks afresh with a new
  target generation. A pre-restart walk cannot publish into the new lineage.
  A root switch walks the new root.
- Ad hoc: two offset clients over 60 s give **24 → 12 walks** (12 cache hits).
  Refresh and mutation bypass. A walk pending across a mutation is not
  cached. A failed walk rejects, is not cached and never becomes `[]`.
  Distinct roots don't share. Entry/byte bounds and LRU eviction work.
  Expired, tracked, untracked and shutdown roots release their values.
- One `JSON.stringify` of the tree per walk and none per cached read.
  Membership-digest semantics are covered.

Commands run (all passed):

- `mise run test:logged -- --name be-e12-all -- mise exec -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src --parallel=2 --only-failures`
- `apps/backend/tests` (`recurring-baseline`, `standalone-ready`,
  `standalone` after `bun run --cwd apps/backend build`)
- root `tests/unit/electron/commands-io-coverage.test.ts`,
  `tests/unit/commands-runtime-state-load-order.test.ts`,
  `tests/unit/lib/backend-conditional-snapshots.test.ts`
- `mise exec -- bun run --cwd apps/backend typecheck`, `mise run format`,
  `mise run format:check`, `mise run lint`

### Remaining limitations

- Containers still have no watcher. An open panel costs about one tree walk
  per 10–15 s (and still one status exec per poll). Git-invisible membership
  changes (ignored files, empty directories, paths past the untracked cap)
  can take up to about 15 s (bound + one poll) to appear, which is outside
  the 6 s budget for those cases only. A manual refresh shows them
  immediately. A container watcher was not added: the plan requires measuring
  its process/resource cost first, and restart/overflow recovery would need
  specifying.
- Ad hoc roots have no signal, so their TTL stays 3 s. With a single panel
  client this saves no walks: it saves the second of two close reads (another
  client, or the post-mutation double read). A same-id container restart
  observed only through ad hoc reads (never tracked) is bounded by that TTL,
  since the lifecycle hooks fire only through `track`/`pause`.
- Roots are resolved with `path.resolve`, not `realpath`: two spellings of a
  symlinked root are separate (correct, but unshared) cache entries.
- Timings were not measured on a named machine. The numbers above are
  deterministic operation counts.
