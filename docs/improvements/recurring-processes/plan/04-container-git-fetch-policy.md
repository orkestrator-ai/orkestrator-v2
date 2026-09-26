# 04 — Separate container fetch freshness from status scans

Status: Implemented (policy, status/fetch script split, protocol freshness,
mutation/lifecycle invalidation, unit, real-Git and script-level Docker
coverage); the isolated-profile app qualification remains for step 12 — see
[Completion notes](#completion-notes). Dependencies: 01, 03. Finding: F02.

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

## Completion notes

Recorded 2026-09-25 on branch `worktree-agent-aaa1aeeaa7064074a` (based on
`implement-recurring-processes-aaceef7ccc03-r1` at `417b1209`, which carries
steps 01, 02, 03, 05, 06, 07, 10 and 11). Commits: `00168ee6` (policy, script
split, protocol, wiring, tests), then a docs commit with the step 04 artifact,
baseline README, architecture note and these notes.

### What landed

**Baseline classification (task 1).** The status script resolves the base in
exactly the old order (`origin/<ref>`, else `<ref>`) and reports which one
resolved in a framed `ORKESTRATOR_BASELINE` section (`tracking` / `local`).
The wrapper classifies: a full 40-hex SHA that resolved locally is `commit`
(present locally and immutable, so it is never fetched). Otherwise it is
`tracking-ref` or `local-ref`, fetched by policy. A base that resolves to
nothing is the existing framed missing-target marker. The comparison itself
is unchanged, and the recorded creation commit is never replaced by the
default branch: `resolveComparisonRef` still decides the ref, and the
real-Git test compares a creation SHA after `origin/main` has moved.

**Fetch extracted from the status script (task 2).**
`buildContainerGitStatusScript` (`commands-files.ts`) no longer runs
`git fetch`. It keeps the exclude maintenance, framed/base64 sections,
untracked cap and decode/size bounds, and prefixes a framed clone identity.
`getContainerGitStatusDetailed` is the wrapper:

1. Run one local-only exec and parse it.
2. On a missing baseline, call `recover()` (at most one bounded fetch) and
   re-resolve exactly once. If the base is still missing, throw the unchanged
   `Target ref is not present in the container: <ref>` error.
3. Otherwise call `observe()`, which may start a background fetch that is
   never awaited, and return `{ changes, truncated, remote }`.

Responses without the new prefix (older fixtures) still parse, and anything
else is still malformed. The fetch is its own program,
`buildContainerFetchScript`:

- It uses the same `docker exec … bash -lc` boundary and the container's own
  Git credential configuration. Credentials are unchanged, and nothing moved
  to the host.
- It sets `GIT_TERMINAL_PROMPT=0` and runs `timeout -k 5 <s> git fetch origin
  "$ref"`, which bounds the in-container process.
- It reports the `origin/<ref>` SHA before and after the fetch.
- It returns at most 2 KiB of stderr (base64-framed). The host classifies it
  into `auth | network | missing-ref | no-remote | timeout | unavailable |
  capacity | error`, then drops the text. It is never logged.

**Key design (task 3).** `ContainerGitFetchPolicy`
(`apps/backend/src/core/container-git-fetch.ts`). A record key combines:

- the container id;
- the container generation, a counter that `forgetContainer` bumps;
- a clone identity digest: sha256 of the top level, the absolute common Git
  dir and its device:inode:birth-time, all reported by the script. A
  workspace re-cloned inside the same container is a new clone, even when the
  filesystem reuses the inode number;
- `origin` and the ref.

State lives in memory, so each backend lifetime is its own generation.
Lifecycle invalidation comes from two calls. `syncDiffStatsTracking` calls
`retainContainers(<running container ids>)`, so stop, recreate, delete and
missed events all converge. `deleteEnvironment` calls `forgetContainer`. A
fetch still running for a forgotten generation settles into a detached
record: it cannot stamp, notify or be joined. A branch change is a different
ref (and a DiffStatsService retarget). Nothing is keyed by branch or project
name alone.

**Policy constants (tasks 4, 5).**

- Single flight per key: joiners share the attempt.
- `CONTAINER_FETCH_COOLDOWN_MS` = 5 min between attempts, stamped on
  completion like `GitFetchScheduler`.
- Each consecutive failure doubles the cooldown, up to
  `CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS` = 30 min (5 → 10 → 20 → 30 → 30).
  This is the bounded negative cache. No failures had been measured to tune
  from, so it is a conservative first trial.
- Fetch timeout: 30 s in the container, plus a 10 s exec margin.
- `lastAttemptAt`, `lastSuccessAt`, the in-flight attempt and the failure
  category are tracked separately.

Freshness is derived from those facts: `not-required`, `current`, `stale`
(with `failure` and `lastSuccessAt`) or `unknown`. It is exposed as the
additive optional `WorktreeSnapshotState.remote` and republished through
`DiffStatsService.remoteFreshnessChanged` when a fetch settles. A republish
does not advance a revision unless the list changed. With the remote
unavailable, the local diff stays fully usable and freshness reads `stale`.
An immutable local base never fetches. A missing ref gets one recovery fetch
per cooldown window, after which the old error surfaces.

**Invalidation (task 6).**

- Merges: `runStoredEnvironmentMerge`, used by every stored merge path of
  `commands-registry-pr.ts`, calls `invalidateEnvironmentRemoteFreshness`
  after any non-pending outcome. For a container that is a `mutation`
  invalidation of the policy. For a local worktree it calls
  `gitFetchScheduler.invalidate`, which had no caller before. The unstored
  `merge_pr` container path also invalidates.
- Explicit refresh: `get_git_status` with `refresh` and
  `refresh_environment_diff_stats` make an `explicit` invalidation. It is
  coalesced with any attempt that started or finished within the last 15 s.
- A mutation makes the key due at once.
- An invalidation that lands while an attempt is waiting or running keeps the
  key dirty; the attempt snapshots `invalidations` when it physically starts.
  When the attempt settles, a follow-up starts immediately.
- A fetch that moves `origin/<ref>` calls step 03's
  `diffStatsService.invalidateBaseline({ containerId })`, never
  `invalidateChanges`. Readers after it wait for the post-fetch scan, and the
  file-list revision advances only if the list changed.

Two paths are deliberately not routed here:

- `fetch_project_git` / `sync_project_git` act on the host clone. Local
  worktrees already see those ref moves through the step 03 watcher, and
  container clones are separate clones.
- The backend cannot observe an agent's push inside a container; the
  cooldown covers it.

**Admission and ordering (task 7).**

- Background fetches acquire the shared `git-docker-scan` pool at `discovery`
  priority under the container's scan target key (`container:<id>`). A fetch
  and a scan of one container therefore never overlap, user reads
  (`interactive`) are admitted first, and other containers are unaffected.
- Reads never wait for a background fetch.
- Missing-baseline recovery runs inside the scan's own slot (the scan already
  holds the target key) and never acquires a second one. If a background
  attempt for the key is still queued, the recovery takes it over: it aborts
  the queued acquisition and performs that same attempt inline. That rules
  out a self-deadlock and keeps it to one fetch.
- Worst case: a hanging remote holds that container's single slot for one
  fetch timeout (≤ 40 s) per cooldown window, and less often after backoff.
  The in-container `timeout` ends the process even if the exec client is
  killed.

**Bounds (tasks 8, 9).**

- Records: at most 256, evicted after 30 min idle or least-recently-used
  first beyond the cap. In-flight records are never evicted; the cap may be
  exceeded briefly rather than permit a duplicate fetch for a generation.
- At most 8 remembered ref classifications per container.
- `status()` reports content-free counts: records, containers, in flight,
  waiting, dirty, failing by category, evicted.
- `git-fetch-container` metrics record:
  - `requested` for every consultation;
  - `coalesced` for joins;
  - `cacheHits` inside the cooldown;
  - `cacheMisses` for attempts;
  - `started` / `completed` / `failed`, with the failure category;
  - the fetch exec itself, charged to the kind. The catalogue entry is now
    300 s, `join`.

**Reconsidered: the 3 s container Files-panel bound.** Kept at 3 s
(`DIFF_CACHE_MAX_AGE_MS`; its comment is updated). Each container read is now
a local-only exec, so it is cheaper. But with the 5 s panel poll, any bound
of 5 s or more would serve every other read from the previous poll and push
change-to-visible to about 10 s, over the 6 s budget. Reducing the exec count
needs a container-side change signal, not a longer age.

### Measured before/after (deterministic harness)

The artifact is `baseline/step-04-container-fetch.json`; the table is in the
[baseline README](../baseline/README.md#step-04--container-fetch-policy-after).
The harness now drives the real policy, charging one separate exec per fetch
(`PHYSICAL_COST.containerFetchDockerExecs` = 1). Diff scans, list reads and
tree walks are identical to step 03 in every scenario.

| Scenario (10 min warm idle) | Network fetch attempts, before → after |
| --- | --- |
| `env1-container-c1` | 120 → 2 |
| `env10-container-c0-pr` | 400 → 20 |
| `env50-container-c1-pr` | 2,080 → 100 (30 s startup window: 154 → 50) |

Docker execs per minute rise by 0.2 per container, because the fetch is now
its own exec. State polls still dominate container exec cost. `--compare
step-04-container-fetch.json --fail-on-change` exits 0, so the run is
deterministic.

### Tests

**Policy through the command seam** — `apps/backend/src/core/container-git-fetch.test.ts`
(`runFetch` seam, manual clock, deferred fetches):

- Repeated scans within the cooldown fetch once, and the next window fetches
  again (120 reads → 2 fetches).
- Concurrent scans join one fetch.
- Unrelated containers, a re-cloned workspace and another ref never share a
  fetch.
- An immutable commit never fetches.
- A missing ref gets one bounded recovery per window, and is recovered once
  it appears.
- An unavailable remote gives `stale` with a category; the local answer stays
  usable.
- Auth failures back off 5/10/20/30 min (at most 12 attempts in 4 h).
- A merge invalidation is immediate, an explicit refresh is rate limited, and
  other containers are untouched.
- An invalidation during an in-flight fetch stays dirty and forces a
  follow-up.
- Container recreation mid-fetch discards the old generation.
- A moved `origin/<ref>` reports one baseline rescan.
- A superseded clone stamps nothing.
- Admission: a fetch waits for the container's scan slot without blocking
  other containers, and in-slot recovery takes over a queued attempt (one
  fetch, no deadlock).
- Bounded, aged eviction never drops in-flight ownership.
- Parser and classifier: malformed framing is rejected, and secret-bearing
  stderr is not retained.
- DiffStatsService publishes and republishes `remote`.

**Real Git** — `apps/backend/src/core/container-git-fetch-git.test.ts` (local
bare remote, production scripts through `bash -c`, no Docker):

- A branch baseline follows `origin/main` only when the policy fetches. A
  merge-invalidation fetch moves it and requests one rescan.
- A creation SHA is compared exactly and never fetched while `origin/main`
  moved.
- A missing ref is recovered by one fetch. A ref absent everywhere keeps the
  missing-target error without refetching.
- An unreachable remote keeps the local diff with `stale` freshness and no
  retry inside the window.
- A re-clone is a new identity.
- The status script contains no fetch.

**Command level:**

- `tests/unit/electron/commands-registry-terminal.test.ts` (fake `docker`):
  five `get_git_status` reads, four of them manual refreshes, cost five
  status execs and one fetch exec.
- `commands-integration.test.ts` "capped container scans" now counts status
  execs only, because a background fetch exec may land between its reads.

**Script-level Docker qualification** (a throwaway script, not committed,
run twice):

- Setup: a disposable `orkestrator-v2:latest` container with `--network none`,
  a `sleep` entrypoint, no Orkestrator owner labels or profile data, and
  removal in `finally`. A local bare remote is bind-mounted. The production
  wrapper and policy are driven through the real `dockerExec` (`docker exec …
  bash -lc`).
- All 15 checks passed:
  - a local-only branch read plus one fetch;
  - no fetch inside the cooldown;
  - mutation → the fetch moved the base → the diff is against the new base;
  - immutable commit: `not-required`, never fetched, exact diff;
  - missing ref recovered by one fetch;
  - absent ref keeps the error without refetching;
  - offline (DNS unavailable): local diff with `stale` / `network`;
  - re-clone in the same container → new identity (overlayfs `stat %w` works
    in the image).

### Checks

- The focused suites above pass. `mise exec -- bun run --cwd apps/backend
  typecheck` and `mise run test:logged -- --name check -- mise run check`
  pass.
- Backend package (`bun test --cwd apps/backend … ./src ./tests`): 4,120
  pass, 14 skip, 9 fail. All nine failures are in `tests/standalone.test.ts`,
  which needs `apps/backend/dist/main.js`. That file is not built in this
  worktree (the package task builds it first), so the failures are unrelated
  to this change.
- `mise run test:changed` (at `00168ee6` plus these docs): all four groups
  pass — workspace (web, backend, desktop, web-public, cli, protocol) 342 s,
  root and agent-support 95 s, bridges 101 s, codex protocol lockfile. (A
  first run was killed by an interrupted session, not by a test failure.)
- The new policy and real-Git suites pass three times in a row.

### Not done / untested constraints

- The isolated-profile app qualification was not run: `mise run dev:test
  --profile … --fixture-environments local,container` plus
  `test:agent:docker`, with the Files panel open on a container, a merge from
  the UI and an inactive-environment switch. The script-level Docker run
  covers the scripts in the real image, but not the app wiring (merge
  commands, lifecycle reconcile, event republication) end to end. Deferred to
  step 12.
- No client renders `remote` yet; web changes belong to steps 06/09. The
  field is additive and validated by the protocol guard.
- `containerRevertFileCommand` still fetches inline before resolving its base.
  It is a rare, user-initiated mutation, and was left unchanged to keep its
  base identical to the previous behaviour.
- The container Files panel still costs one status exec per 5 s read (see
  "Reconsidered" above), and the fetch exec adds 0.2 execs per minute per
  container.
- The failure cooldown ladder is a first trial with no measured failure
  population; tune it from the live `git-fetch-container` metrics.
- Policy `status()` is not registered with the recurring diagnostics
  registry, which only accepts schedulers and pools.

### Rollback

Scoped to container targets:

1. Restore the `git fetch origin "$ref" >/dev/null 2>&1 || true` line in
   `buildContainerGitStatusScript` (fetch before scan).
2. Skip `observe()` / `recover()` in `getContainerGitStatusDetailed`.

Keep the policy module (generation keys, bounded retries, invalidation hooks)
and the additive protocol field, which is absent when unused. Local fetch
sharing (`GitFetchScheduler`) is untouched apart from the new merge
invalidation, which is safe to keep.
