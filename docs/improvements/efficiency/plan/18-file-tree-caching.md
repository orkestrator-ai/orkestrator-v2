# 18 — Cache file trees with watcher and TTL reconciliation

Status: Not started. Prerequisite: 01. Finding: E12.

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
