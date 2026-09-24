# 04 — Separate container fetch freshness from status scans

Status: Not started. Dependencies: 01, 03. Finding: F02.

## Outcome

A local worktree scan should not automatically require another remote fetch.
Containers receive the same basic fetch sharing/freshness discipline already
present in `GitFetchScheduler`, without sharing identities across isolated clones.

## Sources and migration targets

`apps/backend/src/core/commands-files.ts` (`buildContainerGitStatusScript`,
`getContainerGitStatusDetailed`, local baseline helpers), `git-fetch-scheduler.ts`,
`commands-runtime-state.ts`, `commands-registry-terminal.ts`, and known mutation
paths in `commands-registry-pr.ts` / `commands-servers.ts`.

Existing local fetch tests are in `tests/unit/backend/git-fetch-scheduler.test.ts`.
Extend focused container-command tests and add a real isolated container fixture
test for behavior the command seam cannot prove.

## Implementation tasks

1. Classify baselines explicitly: immutable commit already available locally,
   branch/tracking ref, or missing/unknown baseline. Preserve exact comparison
   behavior. Do not substitute the repository's latest default branch for an
   environment's recorded creation commit.
2. Extract fetch orchestration from the status script. The status collector
   reads local Git state, retains framed markers and existing decode/size bounds,
   and reports a missing baseline distinctly. A wrapper decides whether to fetch
   and, if appropriate, retries baseline resolution once after that fetch.
3. Key container fetch state by backend/target generation, immutable container
   identity, repository location and remote/ref. Account for recreation of a
   workspace inside the same container. Invalidate identity on relevant lifecycle
   changes. Never key solely by branch or project name.
4. Share a running fetch among concurrent status readers and use a five-minute
   attempt cooldown as the first trial, matching the local scheduler's shape.
   Maintain `lastAttemptAt`, `lastSuccessAt`, in-flight state and failure category
   separately. A failed attempt can suppress retry storms without claiming refs
   are fresh. Decide a bounded negative-cache policy based on measured failures.
5. For an immutable commit present locally, skip network work. For a missing
   commit/ref, allow bounded fetch recovery and then preserve the existing
   missing-target response; never silently return an empty diff.
6. Route successful push/merge and explicit fetch through invalidation. An
   invalidation during a fetch must remain dirty until a subsequent fresh fetch
   or authoritative result satisfies it. Share the resulting baseline change
   with step 03's snapshot revision so file views do not retain old-base results.
7. Apply external-process concurrency budgets without holding a scan slot while
   waiting indefinitely for a separate fetch slot. Specify acquisition ordering
   and timeouts. A slow/unavailable remote must not freeze all local file views.
8. Keep credentials and shell quoting at existing boundaries. Do not move
   container GitHub/Git credentials to a new host-level service just to batch
   requests. Retain bounded output and sanitized failure categories.
9. Add eviction and lifecycle cleanup for completed fetch cache records. Bound
   both key count and age, and never evict in-flight ownership in a way that
   permits a duplicate fetch for the same generation.

## Tests

Assert that repeated container scans within the cooldown do not invoke fetch
again; concurrent scans join; unrelated containers/clones do not share; a local
commit baseline performs no fetch; missing refs use bounded recovery; unavailable
remote preserves usable local diff with stale remote freshness; retries are
bounded on authentication/network failure; explicit refresh/invalidation behaves
as specified; recreation and branch changes discard the old generation; and
invalidation during an in-flight fetch results in the required follow-up.

Use a fixture repository with a local test remote to verify actual branch/ref
movement, immutable commit comparison and offline behavior without modifying
production remotes. Run the Docker qualification only in an isolated profile.

## Acceptance and rollback

Git fetch attempts follow fetch policy rather than the Files panel cadence.
The changed-file result and missing-baseline behavior match the old path for
equivalent local refs. Before/after counts show the benefit for many containers.
Rollback can restore conservative fetch-before-scan for container targets only;
retain correct generation keys, bounded retries and local sharing.
