# The "ready to merge" shimmer does not check merge permission or a leaf's monitor health

Checked against `main` at `92f8c25a` (2026-10-28).

An environment's name shimmers while its pull request is ready to merge
(`evaluatePrMergeReadiness`, `packages/protocol/src/pr-merge-readiness.ts`; see
[github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge)).
Two of the signals the request asked for are not available, so the rule leaves
them out. Recorded when the shimmer was built.

## Tasks

1. **Viewer permission.** The PR monitor's `gh pr view/list --json` lookup does
   not return whether the credential may merge, and nothing else polls it.
   Fetching it (`gh repo view --json viewerPermission`, or REST
   `permissions.push`) on every poll would add one repository query per
   environment every 20 s. A per-repository cache that is refreshed rarely would
   avoid that. Until then a read-only credential sees the shimmer and then gets
   an error from Merge. Orkestrator merges with the same credential the monitor
   reads with, which normally pushed the branch. Status: open.
2. **A leaf's monitor errors.** A command node decides readiness for another
   machine's rows from that machine's persisted reading (`prMergeability`,
   `prState`, `hasMergeConflicts` in its node summary). The leaf's
   `consecutiveErrors` and its first-answered-check state are not relayed, so a
   leaf whose `gh` keeps failing keeps shimmering while it is connected and its
   summaries are current. This machine's rows do check both. Relaying a boolean
   "reading confirmed" in the environment snapshot would need it to be
   persisted or announced as a resource change. Status: open.
3. **Live evidence.** Confirm against real GitHub that `mergeStateStatus` is
   `CLEAN` for a mergeable PR, `BLOCKED` with a required review outstanding,
   `UNSTABLE` with a failing non-required check, and `DRAFT` or `isDraft` for a
   draft. Also confirm the container image's `gh` accepts the two fields: an
   unknown field makes the whole lookup fail. Status: open.
