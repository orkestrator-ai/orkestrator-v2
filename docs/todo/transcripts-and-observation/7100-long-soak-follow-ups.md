# Long soak follow-ups

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (first analysed 2026-11-06
at `281de1a17`), from the long soak of
[0048](0048-recurring-work-qualification.md) task 10 (see its
[Long soak](0048-recurring-work-qualification.md#long-soak-2026-11-06-linux)).

### Tasks

1. **Release a deleted environment's projection caches**: environment deletion left every session's cached view, revision counter, epoch and projected rows resident. Status: done (2026-11-06; see Assumptions and decisions).
2. **Container lifecycle in a long soak**: the long soak ran local environments only, because the host's Docker address pools were full. Status: open (depends on 7568: 7100 task 2, a node whose agent can reach Docker; beelink2's cannot, see the task).
3. **Projection maps with no eviction**: three per-session maps of the native projection are emptied only by an invalidation or shutdown. Status: done (2026-11-11).
4. **A soak with a browser reader**: no client read session transcripts during the soak, so the progressive-read caches stayed at zero. Status: done (2026-11-11).

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

**Context.** On beelink, 29 of the daemon's 34 networks were unattached `ork-<owner>-reach-probe-net` networks created between 2026-10-31 and 2026-11-02 by other backends, so `dev:test` failed with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. Removing them is the user's call (to-do 0241, retired 2026-11-10; the sweep is `mise run disk:report -- --fix probe-networks`, see [disk usage](../../development/disk-usage.md#what-you-clean-yourself)). This work may remove only what it created, and network pruning is banned. Full pools no longer block a run: the test-only network shim (`apps/desktop/scripts/dev/docker-qualification-bin`, first on `PATH` with `ORKESTRATOR_QUALIFICATION_DOCKER`; see [container qualification](../../development/container-qualification.md)) retries a labelled `network create` on an unrouted /29.

**Investigation.** The driver already takes `--soak-environments local,container --fixture-environments local,container`; nothing else is missing. The 10-cycle container soak of 2026-10-25 left no leaked footprint. On 2026-11-11 the run could not start on beelink2: the agent's user there is not in the `docker` group (`/var/run/docker.sock` is `root:docker` 0660, so every call through the shim answers `permission denied`), and `mise run docker:disposable` needs RootlessKit, which is not installed. A rootful nested daemon needs the outer daemon too. The run therefore needs a fleet node whose agent can reach a Docker daemon, with the shim on `PATH`. Granting that access (installing RootlessKit, or a rootful daemon an agent may use) is the user's call, so it is the checklist item [7568](../manual-test/7568-manual-test-checklist.md) (7100 task 2); once a node is named, an agent runs:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local,container --agent-platforms pi --soak-cycles 60 \
  --soak-environments local,container --soak-cycle-gap-ms 65000 --soak-sessions 2 \
  --soak-readers 1 --profile-prefix rw-ctrsoak --out output/benchmarks/recurring-container-soak.json
```

**Decisions.**

- **How to get container coverage?**
  - **Rerun the same soak with containers on a node whose agent reaches Docker, through the network shim (recommended).**
    - Pros: same driver, gauges and trend analysis, now with the browser reader; a direct comparison; the shim removes the wait on the leaked networks.
    - Cons: not this node (beelink2); the container image build adds time to the first run.
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

### Task 3: each map follows its owner (2026-11-11)

Chose the recommended option, after checking the snapshot share's callers.
In `NativeAgentTranscriptProjection` (`native-agent-transcript-projection.ts`):

- `progressiveReadEpochs`: a read's starting epoch is deleted when the read
  settles. Only `progressiveReadCovering`, which lets a caller join a read in
  flight, reads it.
- `progressiveSourceTokens`: `trimProgressiveTranscriptCache` drops the
  evicted key's source token and any pending background recovery with its
  transcript. The next read has no base to send the token against, so it
  reads the whole window and schedules its own recovery.
- `interactiveSnapshotShares`: a share exists so that the transcript and
  state reads of one session issued together share one provider snapshot. A
  settled share is now kept only while another transcript or state read of
  that session is in flight, and the last of them to settle drops it. Kept
  for the rest of its epoch, it answered every later read in that epoch,
  which moves only on an invalidation, with an older snapshot. Discovery and
  MCP action reads never take a share and do not count: a discovery read
  settles without releasing shares, so counting it let a share outlive the
  reads that used it (review round 2).

Why: each map then tracks something that is already bounded (reads in
flight, the progressive transcript cache), so no new constant is needed, and
join behaviour within a read is unchanged. An LRU bound would have been a
guess and could split a join. Tests: `native-agent-projection-cache-gauges.test.ts`
asserts that a settled read keeps neither its epoch nor its share (and a
later read gets the newer snapshot), that a discovery read still in flight
does not keep a settled share, and that an evicted transcript takes its
source token with it; `native-agent-service-progressive.test.ts` still pins
that reads issued together share one snapshot. The projection, progressive
and sync suites pass. Live: the
task 4 soak below.

### Task 4: a soak-only reader in the existing driver (2026-11-11)

Chose a soak-only reader, `--soak-readers 1` (with `--soak-sessions`), built
from the busy profile's Playwright helpers in
`scripts/recurring-live-ab-busy-clients.ts` (sign-in, environment selection,
the fake reply's visibility check) rather than a second driver.
0048 task 1's client already existed, so the recommended option and this one
converged: `playwrightSoakReader` is one headless page that, after each
cycle's session opens, opens that environment's Pi tab, and after every cycle
each long-lived session's tab, waiting until the fake reply renders. A failed
read is the cycle's `read` step; the soak carries on. `measureSoak` closes
the reader before the final footprint, because its page holds an event
stream that the baseline, taken before its first read, did not (the first
run reported it as a leaked `stream:open 1→2`). Tests:
`tests/unit/recurring-live-ab-soak-sessions.test.ts`.

Live on 2026-11-11, beelink2 (Linux 7.2.15, 16 cores, a busy shared host:
load average 7 to 53 during the first run, with a 7562 (retired) busy run and other
builds beside it), headless `dev:test` profiles with one local fixture
environment, only the Pi toolchain, no credentials, the reachability check
off and every model call on the driver's loopback fake model:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --soak-cycles 40 \
  --soak-environments local --soak-cycle-gap-ms 65000 --soak-sessions 2 \
  --soak-readers 1 --profile-prefix q7100r --out output/benchmarks/q7100r/result.json
# then the confirmation: --soak-cycles 20 --soak-cycle-gap-ms 30000 --profile-prefix q7100r2
```

| Run | Build | Cycles | Duration | Failed steps | Reader | Leaked footprint | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reader, 65 s gap | `83731af28` | 40/40 | 53 min | none | 80 environment reads, 120 tabs | `stream:open 1→2` (the reader's own page) | 1 |
| Confirmation, 30 s gap | `88c1cb15b` (reader closed first) | 20/20 | 15 min | none | 40 environment reads, 60 tabs | none | 0 |

The three task 3 maps over the 40 trend samples of the first run (the
confirmation run agrees):

| Gauge | Range | Last | Reading |
| --- | --- | --- | --- |
| `progressiveReadEpochs` | 0 to 2 | 0 | Follows `progressiveReads` (reads in flight), so it no longer keeps a key per session read. |
| `progressiveSourceTokens` | 2 | 2 | Equal to `progressiveTranscripts`, the two long-lived sessions; each cycle's session was released with its environment. |
| `interactiveSnapshotShares` | 0 | 0 | The share is the fallback for a provider with no transcript or state snapshot route; Pi's provider has both, so this soak cannot exercise it and the unit test covers it. |

The gauges that rose were the two long-lived sessions' growing transcripts
(`progressiveTranscriptBytes` 3.6 to 48 KiB, `projectedMessages` 16 to 328,
`transcriptDeltaBaseBytes` 0 to 19 KiB), the storage row cache (17 to 49
rows) and change tracking's `deletedEnvironments` (1 to 40, one per deleted
environment). None grew by a session that had gone quiet. Backend RSS was 247
MiB before and 393 MiB after. Both profiles were reset by the driver.

### Task 2: waits on the checklist (2026-11-11)

The container soak itself is agent work, but no node this agent can use reaches Docker, and giving an account Docker access (RootlessKit on beelink2, or the rootful daemon) is a host change only the user may make ([Human-only work](../../README.md#human-only-work)). The access is therefore a checklist item in 7568, and this file is `blocked` on it rather than retired, because the run and its reading stay agent work once a node is named.

## Related

- [7568-manual-test-checklist.md](../manual-test/7568-manual-test-checklist.md): 7100 task 2, a node whose agent can reach Docker.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md), task 10.
- To-do 0241 (retired 2026-11-10): the probe-network sweep, described in [disk usage](../../development/disk-usage.md#what-you-clean-yourself).
