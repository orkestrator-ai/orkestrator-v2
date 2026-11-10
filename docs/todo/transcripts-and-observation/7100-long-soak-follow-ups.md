# Long soak follow-ups

## Task analysis

Analysed 2026-11-06 against `main` at `281de1a17`, from the long soak of
[0048](0048-recurring-work-qualification.md) task 10 (see its
[Long soak](0048-recurring-work-qualification.md#long-soak-2026-11-06-linux)).

### Tasks

1. **Release a deleted environment's projection caches**: environment deletion left every session's cached view, revision counter, epoch and projected rows resident. Status: done (2026-11-06; see Assumptions and decisions).
2. **Container lifecycle in a long soak**: the long soak ran local environments only, because the host's Docker address pools were full. Status: open.
3. **Projection maps with no eviction**: three per-session maps of the native projection are emptied only by an invalidation or shutdown. Status: open.
4. **A soak with a browser reader**: no client read session transcripts during the soak, so the progressive-read caches stayed at zero. Status: open (depends on 3 for what to watch).

### 1. Release a deleted environment's projection caches

**Problem.** In the pre-fix soak the native projection's `projections`, `projectionRevisions`, `projectedMessageSessions` and `projectionEpochs` gauges rose by one for every environment the soak created and deleted, and never fell (from 3 to 62 over 60 cycles; after the fix they stayed at the two open sessions for 74 minutes). A deleted environment's views stayed in memory until LRU churn pushed them out.

**Context.** The projection cache is bounded by count only (`NATIVE_PROJECTION_CACHE_LIMIT`, 1,024 entries of up to `NATIVE_PROJECTION_MAX_BYTES`, 16 MiB), revision counters by `NATIVE_PROJECTION_REVISION_LIMIT` (4,096). Environment deletion (`deleteEnvironment`, `commands-servers.ts`) deleted the session records and dropped command catalogues (`forgetEnvironmentCommandCatalogues`), but nothing told the projection.

**Investigation.** Session keys are hashes (`nativeAgentSessionStorageKey`), so a deleted environment's keys cannot be found by prefix. The cached projections keep their own `input`, which names the environment, agent and logical session. `invalidateProjection` already clears every per-session map (sync revisions, history, tool details, projected rows, direct pages, progressive caches) and bumps the epoch to fence a read in flight; `pruneProjectionEpoch` reclaims an epoch only once no read relies on it.

**Decisions.**

- **Where to release them?**
  - **A `forgetEnvironment` on the projection, called from environment deletion after the session records go (recommended, done).**
    - Pros: one call beside the catalogue release; reuses the existing invalidation and epoch fence; deletion is the one moment nothing can read those sessions again.
    - Cons: finds sessions through cached projections only; a session read only through the progressive path is left to that path's own LRU bounds.
  - **Add a byte bound to the projection cache instead.**
    - Pros: bounds memory whatever the cause.
    - Cons: still keeps dead sessions until the bound is reached, and evicts live ones first under pressure.

### 2. Container lifecycle in a long soak

**Problem.** The 2026-11-06 soak exercised local environments only. Container start, stop, delete and their signal and fetch records were not soaked for an hour.

**Context.** On beelink, 29 of the daemon's 34 networks were unattached `ork-<owner>-reach-probe-net` networks created between 2026-10-31 and 2026-11-02 by other backends, so `dev:test` failed with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. Removing them is the user's call (to-do 0241, retired 2026-11-10; the sweep is `mise run disk:report -- --fix probe-networks`, see [disk usage](../../development/disk-usage.md#what-you-clean-yourself)). This work may remove only what it created, and network pruning is banned.

**Investigation.** The driver already takes `--soak-environments local,container --fixture-environments local,container`; nothing else is missing. The 10-cycle container soak of 2026-10-25 left no leaked footprint.

**Decisions.**

- **How to get container coverage?**
  - **Rerun the same soak with containers once the pools have room (recommended).**
    - Pros: same driver, gauges and trend analysis; a direct comparison.
    - Cons: waits on the user clearing the leaked networks, or on another host.
  - **Run it on macOS with Docker Desktop in the 0031 batch.**
    - Pros: no dependency on this host.
    - Cons: a different engine and platform from the local run it would complete.

### 3. Projection maps with no eviction

**Problem.** Three maps of `NativeAgentTranscriptProjection` (`native-agent-transcript-projection.ts`) have no bound and are emptied only by `invalidateProjection`, `forgetEnvironment` or shutdown, so sessions that are read and then go quiet without an invalidation accumulate.

**Context.** Their gauges were zero throughout both soaks (task 4): no client read a transcript through the progressive path. `forgetEnvironment` (task 1) clears them for a deleted environment's cached sessions.

**Investigation.**
- `interactiveSnapshotShares` keeps one entry per (session, provider session), holding the promise of a whole interactive snapshot, replaced only when the session's epoch moves.
- `progressiveReadEpochs` is set on every progressive read and deleted nowhere but `forgetEnvironment` and shutdown.
- `progressiveSourceTokens` keeps its entry when `trimProgressiveTranscriptCache` evicts that key's transcript: the trim drops the transcript and its delta bases but not the source token.

**Decisions.**

- **How to bound them?**
  - **Tie each to its owner's lifetime: delete a read's epoch when the read settles, drop the source token with the evicted transcript, and drop a snapshot share once its promise settles and it is no longer the newest for its session, with gauge assertions in tests (recommended).**
    - Pros: each map then tracks something already bounded; no new constant.
    - Cons: the snapshot share's reuse within one epoch needs checking against its callers before it is shortened.
  - **Give each an LRU bound.**
    - Pros: simple and local.
    - Cons: a bound is a guess, and an evicted share or epoch could change join behaviour.

### 4. A soak with a browser reader

**Problem.** The soak's sessions were driven through the CLI, and the headless Electron window did not open them, so the progressive-read and history caches never filled. Task 3's maps cannot be observed growing or staying flat without a reader.

**Context.** [0048](0048-recurring-work-qualification.md) task 1 (busy profile with 0 to 2 browser clients) plans a Playwright client; this soak needs only one reader that opens each new session's tab and then moves on.

**Investigation.** `scripts/recurring-live-ab.ts` has no browser phase. The gauges and trend analysis (`gaugeTrends`) need no change.

**Decisions.**

- **Where to add the reader?**
  - **With 0048 task 1's Playwright client, reused by the soak (recommended).**
    - Pros: one client driver; the soak gains it for free.
    - Cons: waits for task 1's tooling.
  - **A soak-only Playwright step that opens each session once.**
    - Pros: available sooner.
    - Cons: a second browser driver to maintain.

## Assumptions and decisions

### Task 1: releasing at deletion (2026-11-06)

Chosen: `NativeAgentTranscriptProjection.forgetEnvironment`, reached through
`NativeAgentService.forgetEnvironmentProjections` from `deleteEnvironment`
right after `forgetEnvironmentCommandCatalogues`, so it runs after the
session records are deleted. It collects session keys from the cached
projections' inputs, calls `invalidateProjection` for each, drops the
revision counter and settled progressive-read epochs, and reclaims the
epochs through `pruneProjectionEpoch`, which keeps any epoch a read in
flight still needs. Why: deletion is the only point where no reader can
come back to those sessions, and the existing invalidation already clears
every per-session map; a byte bound would still hold dead views. Tests:
`native-agent-projection-cache-gauges.test.ts` (releases only the deleted
environment's caches) and `commands-environment-cleanup.test.ts` (called
after the session records go). Live: see 0048's
[Long soak](0048-recurring-work-qualification.md#long-soak-2026-11-06-linux).

## Related

- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md), task 10.
- To-do 0241 (retired 2026-11-10): the probe-network sweep, described in [disk usage](../../development/disk-usage.md#what-you-clean-yourself).
