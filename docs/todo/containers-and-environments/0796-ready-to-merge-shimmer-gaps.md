# The "ready to merge" shimmer does not check merge permission or a leaf's monitor health

Checked against `main` at `92f8c25a` (2026-10-28).

An environment's name shimmers while its pull request is ready to merge
(`evaluatePrMergeReadiness`, `packages/protocol/src/pr-merge-readiness.ts`; see
[github-pull-requests.md](../../architecture/github-pull-requests.md#ready-to-merge)).
Viewer permission is not polled, and leaf monitor health is not relayed.
Remote readiness is suppressed until monitor health can be confirmed.

## Tasks

1. **Viewer permission.** The PR monitor's `gh pr view/list --json` lookup does
   not return whether the credential may merge, and nothing else polls it.
   Fetching it (`gh repo view --json viewerPermission`, or REST
   `permissions.push`) on every poll would add one repository query per
   environment every 20 s. A per-repository cache that is refreshed rarely would
   avoid that. Until then a read-only credential sees the shimmer and then gets
   an error from Merge. Orkestrator merges with the same credential the monitor
   reads with, which normally pushed the branch. Status: open.
2. **A leaf's monitor errors.** A command node receives another machine's
   persisted reading (`prMergeability`,
   `prState`, `hasMergeConflicts` in its node summary). The leaf's
   `consecutiveErrors` and its first-answered-check state are not relayed, so a
   leaf whose `gh` keeps failing cannot be distinguished from a healthy leaf.
   Remote sidebar, search and title readiness is now suppressed until monitor
   health is relayed. This machine's rows require confirmation since the latest
   start/resume and no monitor errors or conflicts. A future relay must tie
   confirmation to the leaf's current monitor lifetime, invalidate it on pause
   or detection failure, and reconcile missed events. Status: readiness safely
   suppressed; health relay open.
3. **Live evidence.** Confirm against real GitHub that `mergeStateStatus` is
   `CLEAN` for a mergeable PR, `BLOCKED` with a required review outstanding,
   `UNSTABLE` with a failing non-required check, and `DRAFT` or `isDraft` for a
   draft. Also confirm the container image's `gh` accepts the two fields: an
   unknown field makes the whole lookup fail. Status: open.
