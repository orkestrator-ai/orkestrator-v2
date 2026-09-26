# Recurring-work baseline

Status: Living — step 01 baseline artifact and method; step 12 re-runs it.

This directory holds the deterministic recurring-work baseline produced by
[`apps/backend/scripts/recurring-baseline.ts`](../../../../apps/backend/scripts/recurring-baseline.ts)
and the latency budgets and trial limits later steps are measured against. See
[step 01](../plan/01-baseline-and-measurement.md) for the plan and
[the investigation](../../../imrovements/recurring-processes.md) for the inventory
IDs (B01–B25, C01–C16, L01–L14) referenced below.

## Files

| File | Contents |
| --- | --- |
| `step-01-baseline.json` | Artifact generated at the step 01 commit (commit, platform, runtime, fixture sizes, phases, per-kind counters, modelled cadences, recorder overhead, limitations). |
| `step-05-pr-monitoring.json` | Same harness after step 05 (lifecycle-aware PR monitoring). Only `pr-detection`/`pr-check-rollup` counters and the physical units they charge differ from step 01; see "Step 05 re-run" below. |
| `step-07-baseline.json` | Same scenarios at the step 07 commit (identical counters), plus the driven `nativeObservation` block: the real native activity sweep and queue scan in rollback vs shared mode. |
| `step-03-snapshots.json` | Same harness after step 03 (shared worktree snapshots), plus two appended two-client scenarios. Compare with `--compare step-01-baseline.json`. |
| `step-04-container-fetch.json` | Same harness after step 04 (container fetch policy), on the branch that also carries steps 05 and 07. Container fetches are driven through the real `ContainerGitFetchPolicy`; see "Step 04" below. |

## How to run

```bash
# Print a fresh artifact
mise exec -- bun apps/backend/scripts/recurring-baseline.ts

# Write one, including the real-time recorder overhead measurement
mise exec -- bun apps/backend/scripts/recurring-baseline.ts --overhead \
  --out docs/improvements/recurring-processes/baseline/step-01-baseline.json

# Compare the current tree with the stored artifact (step 12 / every migration)
mise exec -- bun apps/backend/scripts/recurring-baseline.ts \
  --compare docs/improvements/recurring-processes/baseline/step-01-baseline.json

# Prove a change is observation-only: exit 1 on any counter difference
mise exec -- bun apps/backend/scripts/recurring-baseline.ts \
  --compare docs/improvements/recurring-processes/baseline/step-01-baseline.json --fail-on-change
```

The run takes a few seconds and needs no Docker, Git remote, GitHub or
provider. `apps/backend/tests/recurring-baseline.test.ts` keeps the harness
deterministic and content-free.

## Method

The harness constructs the **real** backend owners whose scheduling decides how
much physical work happens, on a manual monotonic clock and a fresh
content-free recorder per scenario:

- `DiffStatsService` — watched local worktrees (400 ms hints, 120 s safety
  scan) and polled containers (15 s).
- `readSharedFileList` — the 3 s shared cache the Files-panel status commands
  use.
- `GitFetchScheduler` — 5 min TTL, joined in flight, keyed by common git dir.
- `PrMonitorService` — normal/pending cadence, 60 s check-rollup budget.
- `ClaudeStatePollManager` — one 1 s state poll per running container.

Fake seams stand in for Git, `gh`, Docker and storage. Each seam charges the
physical work units the production code performs per call at this commit
(`PHYSICAL_COST` in the harness): a local status scan is five `git` spawns plus
one file read per untracked file and a fetch-scheduler consultation; a
container scan is one `docker exec` whose script also attempts `git fetch`; a
PR detection is one `gh`/`docker exec`, plus one branch resolution for unknown
or terminal PRs, plus one rollup query at most every 60 s for open PRs.

Each scenario records a 30 s **startup** phase and a separate 10 min **warm
idle** phase (longer than the 5 min fetch TTL). Clients model the Files panel
open on the first environment, refreshing file list and tree every 5 s.

Owners that need a full backend — native activity sweep, launch/queue scans,
mail presence/injection, coordinator repair, retention, tab cleanup and the
build/looped-review/feature-planning ticks — are reported under `modelledIdle`
as nominal attempts from their catalogued cadence, with record scans scaled by
the completed-workflow fixture. They are never mixed with driven counters.

### Scenario matrix

| Scenario | Environments | Local / container | Clients | PR mix (none/open/terminal) | Completed workflows per store |
| --- | --- | --- | --- | --- | --- |
| `env1-local-c0` | 1 | 1 / 0 | 0 | 1/0/0 | 0 |
| `env1-local-c1` | 1 | 1 / 0 | 1 | 1/0/0 | 0 |
| `env1-container-c1` | 1 | 0 / 1 | 1 | 1/0/0 | 0 |
| `env10-local-c0-pr` | 10 | 10 / 0 | 0 | 4/3/3 | 0 |
| `env10-mixed-c0-pr-wf200` | 10 | 5 / 5 | 0 | 4/3/3 | 200 |
| `env10-mixed-c1-pr-wf200` | 10 | 5 / 5 | 1 | 4/3/3 | 200 |
| `env10-mixed-c2-pr-wf200` | 10 | 5 / 5 | 2 | 4/3/3 | 200 |
| `env10-container-c0-pr` | 10 | 0 / 10 | 0 | 4/3/3 | 0 |
| `env50-mixed-c0-pr-wf200` | 50 | 25 / 25 | 0 | 17/17/16 | 200 |
| `env50-mixed-c2-pr-wf200` | 50 | 25 / 25 | 2 | 17/17/16 | 200 |
| `env50-container-c1-pr` | 50 | 0 / 50 | 1 | 17/17/16 | 0 |

## Measured baseline (deterministic call counts)

Artifact `step-01-baseline.json`, commit `666a0a76c705`, linux x64, Bun 1.4.2.
Counts are for the 10 min warm-idle window; physical units are per minute.
The run is deterministic: regenerating it at the same commit reproduces every
counter exactly (`--compare … --fail-on-change` exits 0).

| Scenario | Diff scans | File-list reads (cache hits) | Tree walks | Local fetch consults / fetches | Container fetch attempts | PR detections / rollups | tmux polls | git / gh / docker exec per min | readdir per min |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `env1-local-c0` | 5 | 0 | 0 | 5 / 1 | 0 | 0 / 0 | 0 | 2.6 / 0 / 0 | 0 |
| `env1-local-c1` | 5 | 120 (5) | 120 | 120 / 2 | 0 | 0 / 0 | 0 | 60.2 / 0 / 0 | 480 |
| `env1-container-c1` | 40 | 120 (40) | 120 | 0 / 0 | 120 | 0 / 0 | 600 | 0 / 0 / 84 | 0 |
| `env10-local-c0-pr` | 50 | 0 | 0 | 50 / 1 | 0 | 180 / 30 | 0 | 34.1 / 21 / 0 | 0 |
| `env10-mixed-c0-pr-wf200` | 225 | 0 | 0 | 25 / 1 | 200 | 180 / 30 | 3,000 | 15.6 / 11 / 336 | 0 |
| `env10-mixed-c1-pr-wf200` | 225 | 120 (5) | 120 | 140 / 2 | 200 | 180 / 30 | 3,000 | 73.2 / 11 / 336 | 480 |
| `env10-mixed-c2-pr-wf200` | 225 | 240 (10) | 240 | 255 / 2 | 200 | 180 / 30 | 3,000 | 130.7 / 11 / 336 | 960 |
| `env10-container-c0-pr` | 400 | 0 | 0 | 0 / 0 | 400 | 180 / 30 | 6,000 | 0 / 0 / 670 | 0 |
| `env50-mixed-c0-pr-wf200` | 1,125 | 0 | 0 | 125 / 1 | 1,000 | 990 / 170 | 15,000 | 86.6 / 56 / 1,684 | 0 |
| `env50-mixed-c2-pr-wf200` | 1,125 | 240 (10) | 240 | 355 / 2 | 1,000 | 990 / 170 | 15,000 | 201.7 / 56 / 1,684 | 960 |
| `env50-container-c1-pr` | 2,000 | 120 (40) | 120 | 0 / 0 | 2,080 | 990 / 170 | 30,000 | 0 / 0 / 3,384 | 0 |

Modelled (not driven) for every scenario over the same window: the native
activity sweep, launch scan, queue scan, Claude state reconcile, tmux queue
drain, mail presence, mail injection and pending-rename reconcile each attempt
300 passes (2 s); coordinator repair, mail retention and tab cleanup 10 (60 s);
lease expiry 40 (15 s); feature planning 600 ticks (1 s). With 200 completed
records per store, the build supervisor (1.5 s) and looped review (1 s) ticks
enumerate 80,000 and 120,000 records respectively, although no record is
active.

What the baseline attributes, by owner:

1. **Container state polls dominate container idle cost.** One `docker exec`
   per running container per second (B18): 3,000 of the 3,384 execs per minute
   in `env50-container-c1-pr`. Container diff scans add 4 per container per
   minute, each also attempting `git fetch` (F02).
2. **A second client doubles Files-panel work; the shared cache barely helps.**
   Each open panel issues 12 list reads and 12 tree walks per minute; the 3 s
   cache served 5 of 120 local reads (the ones landing just after a safety
   scan) and 40 of 120 container reads (15 s scans). Two clients meant 240
   reads with 10 hits — about 57 extra `git` spawns and 480 `readdir` calls per
   minute per panel (F01). Backend-owned diff, PR and poll counts are identical
   with 0, 1 or 2 clients.
3. **Terminal PRs cost the same as open ones.** Every PR entry is checked every
   20 s whatever its state: 990 detections per 10 min at 50 environments, with
   terminal entries also resolving their branch each time (F03). Open PRs add a
   rollup query at most once a minute.
4. **Workflow ticks scale with history, not activity.** Record enumeration per
   tick grows linearly with completed records (F06). The build-pipeline and
   review stores are read with an uncached `loadJson` on every tick; only the
   environment, project, config, layout and mail stores use the stat-validated
   cache.
5. **Local fetching is already well bounded.** Every local scan consults the
   fetch scheduler, but one fetch per 5 min TTL serves all worktrees of a
   repository (B05).

### Step 05 re-run (PR monitoring)

`step-05-pr-monitoring.json`, generated at `fad57961` (step 05 code in
`ceebd7a2`, harness seeding in `fad57961`). The harness change is
comparability-preserving: `PrMonitorService` now jitters restored and terminal
schedules, so the harness passes it a seeded uniform source
(`seededRandom(scenario.id)`); regenerating reproduces every counter
(`--compare step-05-pr-monitoring.json --fail-on-change` exits 0). The fixture,
phases and cost model are unchanged. Compared with `step-01-baseline.json`,
152 counters differ, all in `pr-detection`, `pr-check-rollup` and the
per-minute physical units they charge; no other owner moved.

| Scenario (10 min warm idle) | PR entries open / terminal | PR detections before → after | Rollups | Physical units per min |
| --- | --- | --- | --- | --- |
| `env10-local-c0-pr` | 3 / 3 | 180 → 96 | 30 → 30 | gh 21 → 12.6; branch-resolution spawns 9 → 0.6 |
| `env10-mixed-*-pr-wf200` | 3 / 3 | 180 → 96 | 30 → 30 | docker exec −11.2, gh −2.8, branch-resolution −2.8 |
| `env10-container-c0-pr` | 3 / 3 | 180 → 96 | 30 → 30 | docker exec 670 → 653.2 |
| `env50-mixed-*-pr-wf200` | 17 / 16 | 990 → 542 | 170 → 170 | gh 56 → 33.6; docker exec −44.8; branch-resolution −22.4 |
| `env50-container-c1-pr` | 17 / 16 | 990 → 541 | 170 → 170 | docker exec 3,384 → 3,294.2 |

Open entries keep exactly 30 detections per 10 min (20 s); each terminal entry
goes from 30 to 2 per 10 min (one discovery per five-minute period, after a
local repair that makes no `gh` call), and each discovery still resolves the
live branch. The 30 s startup window shows fewer detections because restored
entries are spread over [20 s, 40 s) and restored terminal entries repair
locally first. Durations and queue delays are not modelled (detections resolve
instantly), so the two-concurrent admission bound is proven by unit tests, not
by this artifact.
## Driven native observation (step 07)

`recurring-baseline-native.ts` drives the **real** `NativeAgentService`
activity sweep and native prompt-queue scan every 2 s for 10 min on a manual
clock, with a real `StorageService` in a temporary directory and fake providers
counted at the provider boundary. Fixture: 10 local environments, one session
each, agents cycled codex/claude/pi/cursor/opencode; environments 0–1 are
mid-turn with a queued prompt; an idle OpenCode session is started by another
client twice, once with its provider event lost and once with it delivered.
Both modes run the identical workload; `rollback` is
`observationSharing: false` (`ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`), which
reproduces the pre-step-07 cadence.

| Mode | No-touch activity reads | Tab-facing status reads | Provider reads / min | Groups served from a retained observation | External start seen (event lost / delivered) | External end seen | Turn-end edges |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rollback | 3,000 | 1,200 | 420 | 0 | 1.5 s / 1.5 s | 1.5 s | 2 |
| shared | 2,722 | 0 | 272.2 | 558 | 1.5 s / 1.5 s | 1.5 s | 2 |

The 1,200 status reads were the two busy queues' `ensureSession` + drain
status reads (two per queue per 2 s pass) — tab-facing routes, i.e. a liveness
touch on Codex and a transcript hydrate on Claude — now answered by the sweep's
no-touch observation. The 278 fewer activity reads are OpenCode idle groups
backing off to a 4 s safety read behind their live event stream. Discovery of
an externally started turn is bounded by that ladder (≤ 4 s with the event
lost, next sweep with it delivered); the recorded 1.5 s is this fixture's
phase, not the worst case. Bridge-side cost per read, mail, coordinator and
workflow consumers are not driven.

## Step 03 — shared worktree snapshots (after)

Artifact `step-03-snapshots.json`. The harness now drives the Files-panel
reads through the production owner (`DiffStatsService.readFileList` /
`readTree`, behind a `git-docker-scan` admission pool) instead of the removed
3 s shared cache; seams and `PHYSICAL_COST` are unchanged, so every step 01
scenario compares directly. Two scenarios were appended (`env1-local-c2`,
`env1-container-c2`); they have no step 01 row. 10 min warm idle:

| Scenario | Physical status scans (diff + list) | List reads (served without a scan) | Tree walks | git/min | docker exec/min | readdir/min |
| --- | --- | --- | --- | --- | --- | --- |
| `env1-local-c0` | 5 → 5 | 0 → 0 | 0 → 0 | 2.6 → 2.6 | 0 → 0 | 0 → 0 |
| `env1-local-c1` | 120 → 5 | 120 (5) → 120 (120) | 120 → 0 | 60.2 → 2.6 | 0 → 0 | 480 → 0 |
| `env1-container-c1` | 120 → 120 | 120 (40) → 120 (0) | 120 → 120 | 0 → 0 | 84 → 84 | 0 → 0 |
| `env10-mixed-c1-pr-wf200` | 340 → 225 | 120 (5) → 120 (120) | 120 → 0 | 73.2 → 15.6 | 336 → 336 | 480 → 0 |
| `env10-mixed-c2-pr-wf200` | 455 → 225 | 240 (10) → 240 (240) | 240 → 0 | 130.7 → 15.6 | 336 → 336 | 960 → 0 |
| `env50-mixed-c2-pr-wf200` | 1,355 → 1,125 | 240 (10) → 240 (240) | 240 → 0 | 201.7 → 86.6 | 1,684 → 1,684 | 960 → 0 |
| `env50-container-c1-pr` | 2,080 → 2,080 | 120 (40) → 120 (0) | 120 → 120 | 0 → 0 | 3,384 → 3,384 | 0 → 0 |
| `env1-local-c2` (new) | — → 5 | — → 240 (240) | — → 0 | — → 2.6 | — → 0 | — → 0 |
| `env1-container-c2` (new) | — → 120 | — → 240 (0; 120 joined) | — → 120 | — → 0 | — → 84 | — → 0 |

Scenarios without a client are unchanged (identical counters).

- **Watched local worktrees**: an open Files panel — one or two clients — no
  longer costs anything beyond the backend's own diff statistics: every 5 s
  read is answered from the owner's valid watched state (no Git spawn, no
  tree walk). The ~57 `git` spawns and 480 `readdir` per minute per panel are
  gone; the safety scan (120 s) and fetch cadence are unchanged.
- **Containers**: one client costs the same (84 execs/min) — the panel needs
  data at most 3 s old every 5 s, so each read still scans; the periodic
  15 s scan is now skipped because the read's scan already refreshed the
  counts (the 40 "cache hits" of step 01 became 40 skipped periodic scans).
  Two clients share one scan and one tree walk per tick (`env1-container-c2`:
  120 scans for 240 reads) instead of each paying for its own.
- Not modelled here (see Limitations): edit bursts, where each hint now also
  re-walks the tree once while a panel shows it, and real client clocks,
  where two unsynchronised clients join less often than in this lockstep
  model (a second read within 3 s still reuses the first).

## Step 04 — container fetch policy (after)

Artifact `step-04-container-fetch.json`. The container scan seam now charges
one local-only status exec, and consults the real `ContainerGitFetchPolicy`
(5 min attempt cooldown per container generation + clone + ref, joined in
flight, background fetches in the shared `git-docker-scan` pool). Each fetch
is one separate `docker exec` (`PHYSICAL_COST.containerFetchDockerExecs`).
The modelled remote is idle: fetches succeed and never move `origin/main`, so
no fetch-triggered rescan occurs. Compared with `step-03-snapshots.json`:
diff scans, file-list reads and tree walks are identical in every scenario;
the other differences are step 05's PR monitoring, which this branch also
carries (tabulated in "Step 05 re-run").

Before step 04 every container status scan ran `git fetch origin <ref>`, so
network fetch attempts equalled container scans (the `git-fetch-container`
`requested` count, which was the only counter). After, `requested` still
counts every consultation and `started` counts real attempts. 10 min warm
idle:

| Scenario | Container scans (unchanged) | Network fetch attempts before → after | Startup (30 s) attempts before → after | docker exec/min change from step 04 |
| --- | --- | --- | --- | --- |
| `env1-container-c1` | 120 | 120 → 2 | 7 → 1 | +0.2 (84 → 84.2) |
| `env1-container-c2` | 120 | 120 → 2 | 7 → 1 | +0.2 |
| `env10-mixed-*-pr-wf200` (5 containers) | 200 | 200 → 10 | 15 → 5 | +1.0 |
| `env10-container-c0-pr` | 400 | 400 → 20 | 30 → 10 | +2.0 |
| `env50-mixed-*-pr-wf200` (25 containers) | 1,000 | 1,000 → 50 | 75 → 25 | +5.0 |
| `env50-container-c1-pr` | 2,080 | 2,080 → 100 | 154 → 50 | +10.0 |

(`docker exec/min` totals in the artifact also include step 05's PR
reduction, e.g. `env50-container-c1-pr` 3,384 → 3,304.2 = −89.8 from step 05
+10 from step 04.)

- **Network work follows fetch policy, not the Files-panel cadence**: one
  attempt per container per 5 min (plus one at startup): −95% for containers
  polled every 15 s without a panel (20:1), −98% for the container whose
  Files panel is open (60:1; 12 reads per minute used to be 12 fetch
  attempts).
- **Exec count is not reduced.** Every status exec is now local-only (no
  network round trip, no remote auth, no `.git` lock contention with a fetch),
  but the separate fetch exec adds 0.2 execs per container per minute. Per-scan
  host cost (the exec itself) is unchanged and remains dominated by state
  polls (step 07's area).
- **The 3 s container file-list bound was reconsidered and kept.** A 5 s
  panel poll with any bound of 5 s or more would serve every other read from
  the previous poll, letting a change take up to ~10 s to show — over the 6 s
  Files-panel budget. The single-client container panel therefore still costs
  one status exec per read (84 exec/min including state polls); it is simply
  cheaper per exec now.
- **Immutable creation commits never fetch** (not modelled here: every
  fixture uses `main`); **missing refs** get one bounded recovery fetch per
  cooldown window; **failures** back off 5 → 10 → 20 → 30 min.
- Not modelled: a moving remote (each fetch that moves `origin/<ref>` adds
  one rescan exec via `invalidateBaseline`), merges/explicit refreshes (each
  makes the key due at once; explicit refreshes coalesce within 15 s), and
  fetch durations (a slow fetch holds the container's single scan slot, see
  the plan's completion notes).

## Limitations — what this does not measure

This is a deterministic **call-count** baseline, not live wall-clock profiling.
It proves how often each owner attempts work, how often requests join or hit a
cache, and the physical work those attempts imply under the cost model. It does
not measure:

- Real durations, CPU, RSS, battery or I/O bytes of spawned processes. The
  recorder captures durations live (`get_recurring_work_diagnostics`, and the
  `recurringWork` block of the gateway's `/api/metrics`), but a comparable
  number needs the live isolated profile below.
- Provider reads, transcript serialization and storage costs of the native
  sweep, mail, queues and workflow supervisors (modelled cadence only).
- Freshness: authoritative-change-to-visible latency for approvals, completion,
  file lists, diff badges and PR transitions; recovery after a missed hint;
  burst edits, long Git reads, network outage and client resume.
- Renderer polling other than the Files panel (native session views, meters,
  reviewer transcripts), and bridge-side recurrence.

**Live isolated profile (still required before step 12 claims savings).**
Start `mise run dev:test --profile recurring-baseline --fixture` with
`--fixture-environments local,container`, create 10 environments against the
returned `testProject`, keep 0/1/2 browser clients attached, and sample
`/api/metrics` (`recurringWork`) plus process CPU/RSS every 30 s for at least
five minutes of warm idle, then for scripted burst saves, one active turn, a
pending approval, a queued prompt, a workflow completion and a network outage.
Repeat three times to establish variability. The recorder already reports
per-kind durations, queue delay, last-success age and worst in-flight age; the
profile adds wall-clock freshness observed in the browser.

## Recorder overhead

Measured by `--overhead` (real time, excluded from comparisons): the cost of one
`requested` + `observe` pair, enabled vs disabled, over 200,000 iterations.

| Recorder | ns per attempt |
| --- | --- |
| Enabled | 660 |
| Disabled (`ORKESTRATOR_RECURRING_METRICS=0`) | 92 |

Measured on a shared, heavily loaded host (load average above 30 during the
run), so treat it as an upper bound. At the busiest driven scenario — about
3,500 observed attempts per minute (`env50-container-c1-pr`, dominated by
tmux polls) plus a few thousand unit increments — the enabled recorder costs
roughly 2–5 ms of CPU per minute.
Memory is bounded by the vocabulary (one fixed record per kind) plus at most
1,024 tracked in-flight attempts. Collecting a snapshot performs no I/O.

## Latency budgets

Budgets are the current nominal behavior plus a tolerance. A later step may
change cadence only while the relevant budget still holds, and must record the
measured p50/p95 against it; a slower policy that exceeds a budget must be
accepted explicitly here (terminal PR discovery is the one planned exception).
These are targets for the live profile — the deterministic harness does not
measure them.

| Freshness | Current nominal | Budget (p95) | Notes |
| --- | --- | --- | --- |
| Pending approval / question visible, active view | 500 ms refresh (C01) | ≤ 2 s | Approval timeout still denies; never relaxed |
| Background environment activity indicator | 2 s sweep (B06) | ≤ 4 s | |
| Turn completion visible / queued prompt dispatched | turn-end edge + 2 s sweep (B06/B07) | ≤ 3 s | Edge path should dominate |
| Mail presence | 2 s refresh, 4 s TTL (B10) | ≤ 4 s | Never inject into an active session |
| Diff badge, watched local worktree | 400 ms hint + scan (B03) | ≤ 2 s after save settles | Missed hint recovered within the 120 s safety scan |
| Diff badge, container / unwatched | 15 s poll (B03) | ≤ 20 s | |
| Files panel list/tree, panel open | 5 s client poll, 3 s cache (B04/C02) | ≤ 6 s; ≤ 1 s after an explicit action | Explicit refresh must wait for a post-click read |
| PR merge confirmation after merge-pending | 1 s (B01) | ≤ 3 s | |
| PR created after create-pending | 5 s (B01) | ≤ 10 s | |
| Open PR state change | 20 s (B01) | ≤ 30 s | Includes jitter |
| Terminal PR replacement/reopen discovery | 20 s today (B01/F03) | ≤ 5 min + immediate explicit/completion wake | Planned intentional slowdown (step 05) |
| Workflow progression after a result | 1–1.5 s tick (B14–B17) | ≤ 3 s | Keyed wakeups should beat this |
| Lease renewal, approval/auth expiry, watchdogs | 5 s / 15 s lease (B15/B16), durable deadlines | Unchanged | Critical class; never queued behind best-effort work |
| Recovery after a deliberately missed hint | safety scans (120 s diff, interval elsewhere) | Unchanged or better | Required before any polling reduction (step 11) |

## Trial limits

Initial experiment values from the [plan index](../plan/00-index.md); none is
shipped behavior yet. The step 02 primitives default to these where they apply
(`DEFAULT_ADMISSION_POOL_LIMITS` in `apps/backend/src/core/work-admission.ts`).

| Work | Initial trial | Primitive default |
| --- | --- | --- |
| PR ordinary open / pending | Preserve 20 s / 5 s / 1 s cadence; bounded admission | `external-pr` pool: 2 concurrent, 1 per target |
| Terminal PR discovery after successful repair | 5 min plus immediate explicit and completion-edge wakeups | Scheduler `requestSooner`/`invalidate` |
| Git/Docker status scans | 4 total scans, 1 per target | `git-docker-scan` pool: 4 concurrent, 1 per target |
| GitHub detection | 2 concurrent; bounded fair waiting; shared cooldown by safe auth/host scope | `external-pr` pool; cooldown is step 05 |
| Container fetch freshness | 5 min between attempts; immutable local base does not fetch | Step 04: `ContainerGitFetchPolicy` (5 min, failures doubling to 30 min, explicit refresh ≥ 15 s apart) |
| Client foreground polling | Preserve cadence during coordinator migration | Step 06 |
| Client quiet native views | Later 3/5/10/15 s backoff after event coverage passes | Step 06/07 |
| Active workflow progress | Preserve 1–1.5 s fallback until scoped notifications qualify | `workflow-provider` pool: 8 concurrent, 2 per target |
| Idle discovery/maintenance | 30–60 s pending-work discovery; longer retention | Step 08 |
| Leases, approval deadlines, authentication expiry | Preserve semantics and timing | Scheduler `critical` class: separate concurrency |
