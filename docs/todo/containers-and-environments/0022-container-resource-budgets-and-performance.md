# Container resource budgets and performance

Checked against `main` at `20f6de91` (2026-10-25).

New runtimes now get a built-in default budget for their daemon: no CPU cap,
memory 8 GiB capped at 75% of the daemon's memory, 4,096 PIDs. It was chosen
from browser, build, provider-turn and combined workloads measured on Docker
Desktop (arm64) and Linux Engine (amd64), with and without the experiment
budget. The benchmark harness now runs under the default, and the deferred
optimisations were measured against their stated conditions. What remains is
a Linux arm64 benchmark run, UI response under multi-environment load, and
authenticated provider turns.

## Current state

- `resolveResourceLimits` (`apps/backend/src/core/container-resources.ts`)
  resolves the environment override, then `global.containerResourceLimits`
  (Settings → Container), then `builtInResourceDefault`
  (`packages/protocol/src/container-resources.ts`) for the daemon's capacity
  and enforcement support. All-`null` limits are an explicit opt-out. The
  budget is resolved only at create or rebuild. A default axis the daemon
  cannot enforce is left off and reported (`unenforced`, the policy's
  `unsupported`), never refused. `get_docker_capacity` carries
  `builtInDefault`, and a policy's source is `default`. Settings has three
  modes: built-in default, custom, no limits. Details are in
  [container-lifecycle.md](../../architecture/container-lifecycle.md#built-in-default).
- `set_container_resource_limits` now writes through
  `setContainerResourceLimits`. Before this, `null` never removed a stored
  budget: `updateGlobalConfig` keeps any value a save omits.
- `parseAppliedLimits` accepts Docker 29's `<no value>` for an unset
  `PidsLimit`. Before this, every container without a PID limit reported its
  applied limits as unknown.
- `/dev/shm` is 1 GiB, or half the memory limit when that is smaller.
- The usage sampler, capacity caches, admission limits, OOM events and log
  bounds are unchanged; see the lifecycle document.
- The copy verifier still hashes the source once per tar member
  (`copy_stream` in `docker/orkestrator-migrate.sh`); the destination batches
  256 files per `sha256sum`.
- `docker/Dockerfile` has no BuildKit `--mount=type=cache`, by decision
  (below).
- Harnesses:
  - `apps/backend/tests/container-benchmarks.test.ts` runs under the
    built-in default. `ORKESTRATOR_BENCHMARK_UNRESTRICTED=1` runs it
    unrestricted, and the report records `budget` and `appliedLimits`.
    `container-live-qualification.yml` now runs it on `ubuntu-24.04` and
    `ubuntu-24.04-arm` and uploads the report.
  - `apps/backend/scripts/container-workload-budget.ts`, with
    `scripts/container-workload/`, is the workload harness
    ([container-qualification.md](../../development/container-qualification.md#workload-budgets)).

## Outstanding work

### Code

1. ~~Choose and apply a default budget once the workloads below are
   measured.~~ **Done.** The values and their headroom rationale are in
   `container-lifecycle.md` ("Built-in default"). The default applies only
   to runtimes created or rebuilt from now on. Unsupported enforcement is
   reported, not claimed: Settings names the axis, and so does the
   environment's resources panel.

### Qualification

- ~~Measure realistic workloads with and without the experiment budget of 2
  CPUs, 4 GiB and 1,024 PIDs, on Linux Engine and on Docker Desktop.~~
  **Done** (evidence below). Provider turns ran the real Claude Code CLI
  with real tool calls, against a loopback mock of the Messages API; no
  credentials were available here.
- ~~Benchmark numbers for Docker Desktop and arm64 against the regression
  targets.~~ **Done for Docker Desktop on arm64** (evidence below).
- **Open:** benchmark numbers on Linux Engine arm64. Neither machine here
  has it. The weekly `container-live-qualification.yml` job now runs the
  harness on `ubuntu-24.04-arm` and uploads `container-benchmarks-linux-arm64`;
  compare its report with the targets and record it here.
- **Open:** UI response under multi-environment load. This needs a real-stack
  `dev:test` profile with several busy container environments and a browser
  latency probe. No such probe exists (the efficiency harness counts work,
  not UI latency), and none was built in this pass.
- **Open:** real provider and bridge authentication paths under a budget: an
  authenticated turn through each bridge (Claude, Codex, OpenCode, Cursor,
  Grok, Pi) with the default applied. They need provider logins, which this
  machine did not have. The mock-API turns bound the Claude CLI's own
  footprint (about 360 MiB anonymous memory for three concurrent CLIs), not
  a bridge's or another provider's.

### Deferred until measured

- An in-process tar hasher to replace per-member `sha256sum` on the source
  side. **Measured, still deferred.** The 5,000-file copy and verify on
  Docker Desktop arm64 took 17.5 s under the default and 19.0 s
  unrestricted, against the 20 s target, with the host at load average
  about 50 (3.5–3.8 ms per file, both sides). Revisit if
  `rebuild.medium.copying` misses 20 s on the reference host or the CI
  runners. It needs its own safety review: the same corruption,
  symlink-root and Git checks must still pass.
- Aggregate per-environment diagnostic byte accounting. **Still deferred.**
  The total is bounded by construction. The six `boundedBackgroundLaunch`
  files (Claude, Codex, Cursor, Pi and ACP bridges, OpenCode server) are each
  at most 5 MiB × 3, plus Docker's `local` log at 10 MiB × 3: at most 120 MiB
  per runtime, and a rebuild discards the `/tmp` copies. Live sizes would
  need a `docker exec` per environment, the polling cost
  [0020](0020-container-state-observation.md) works to remove. Revisit if a
  surface needs actual sizes, or more launch files appear.

### Rejected for now

Revisit only if measurements change.

- Bun download-cache BuildKit mounts in `docker/Dockerfile`. **Measured.**
  The bridge `bun install` layer re-ran cold in a local rebuild
  (2026-10-25, Desktop arm64) and took 5.5 s. It re-runs only when the
  lockfile, `patches/` or a workspace `package.json` changes, because the
  source is copied after it. CI release builds start without the mount
  cache anyway. Saving at most about 5 s per dependency change does not pay
  for the build-cache disk growth and the extra Dockerfile syntax.
- Environment-private dependency cache volumes. **Measured.** A cold
  `bun install` of this repository (941 packages) in a fresh container took
  8.0–19.6 s on Desktop and 10.3–11.0 s on Linux. A warm reinstall
  from the container's cache took 1.2–2.2 s and 2.6–3.1 s. So
  downloads cost about 7–17 s, once per new environment: `node_modules`
  lives in the workspace volume, which preserving rebuilds copy. That does
  not dominate an environment's life, so the condition ("only if downloads
  dominate") is not met. Sharing a cache across environments would still
  need cache-poisoning and concurrency analysis.
- Faster usage samples. **Measured.** A sample took 2.0 s (median; Desktop
  arm64, 8 running containers), nearly all of it `docker stats --no-stream`'s
  own CPU interval. Samples are shared, the visible refresh is 5 s, and the
  Docker view costs 24 Docker calls a minute against a target of 36.
- Reusing verified input revisions. Staging sits inside the create step and
  is not a dominant phase. If it is revisited, revocation must bypass the
  cache, and size or time alone is not proof that secret or configuration
  contents are unchanged.
- A Docker events watcher for status sampling. The sampler costs three calls
  per sample regardless of environment count (measured again: 3), and the 3 s
  status cache already batches `docker ps`. Events would only ever be hints:
  a full owned snapshot after every gap, with periodic reconciliation kept as
  the repair path.
- A snapshot or reflink copy fast path. It is not portable across Engine and
  Desktop storage drivers, and the verified streaming copy is the contract.

## Evidence (2026-10-25)

Both machines were busy with other work during every run, so the timings
are noisy. The Mac's load average was about 50 on 18 cores (other
worktrees' test suites). The Linux host was at about 8 on 12 threads (the
user's own Bun processes). Memory and PID peaks, OOM kills and failures are
robust; wall times are not. Peaks are the kernel's `memory.peak` (which
includes reclaimable page cache) and the sampler's anonymous and `shmem`
maxima.

**Docker Desktop 29.9.2, arm64.** The VM has 18 CPUs and 7.75 GiB, so the
default there is 5,888 MiB and 4,096 PIDs. Image `orkestrator-v2:q0022-arm64`
(this branch). Reports: `output/benchmarks/workload-desktop-arm64*.json`.

| Workload | Condition | Wall | Peak MiB (anon / shmem) | PIDs | Outcome |
| --- | --- | --- | --- | --- | --- |
| Browser, 3 × 2 heavy pages | unrestricted | 14.5 s | 6,046 (4,141 / 1,762) | 379 | clean |
| | 2 CPU / 4 GiB / 1,024 | 47.7 s | 4,096 (limit) | 373 | **2 OOM kills, 2 page crashes, 8 of 24 rounds failed** |
| | default | 11.9 s | 5,885 (4,033 / 1,741) | 377 | clean |
| Browser, 1 × 2 pages | unrestricted / budget / default | 9.8 / 14.9 / 10.3 s | 2,346 (1,706 / 616) | 136 | clean |
| Provider, 3 CLIs × 3 turns, 36 tool calls | all three | 17.0–17.2 s | 738 (366 / 0) | 57–110 | clean |
| Build: install, typecheck, Vite | unrestricted | 31 s | 4,777 (2,481 / 0) | 206 | clean |
| | budget | 24 s | 3,724 (1,778 / 0) | 67 | clean |
| | default | 54 s | 4,230 (2,238 / 0) | 214 | clean |
| Combined: build, 1 browser, 2 CLIs | unrestricted | 35.1 s | 4,846 (2,925 / 595) | 392 | clean |
| | budget | 41.4 s | 4,096 (limit, reclaiming) | 203 | clean |
| | default | 66.6 s | 5,144 (2,993 / 586) | 387 | clean |

CPU only (2 CPUs, no memory or PID limit), three interleaved repeats. The
one-browser round median rose from 2.55–2.64 s to 3.69–4.57 s, every time.
The build showed no consistent difference: typecheck 10.3–20.3 s against
10.0–11.4 s, Vite 4.4–7.6 s against 3.9–5.6 s. Its tools finish in seconds
and contention dominates.

**Linux Engine 29.9.1 rootful, amd64.** Omarchy, kernel 7.2.8, 12 threads,
31 GiB, cgroup v2, systemd driver, driven from the Mac with
`DOCKER_HOST=ssh://`. The default there is 8,192 MiB and 4,096 PIDs. The image
is the host's own `orkestrator-v2:dev-f7622900ba3f` (2026-09-28): its disk had
12 GB free, too little to load a 6 GB current image. That image ships Bun
1.4.2, so the build workload installs the checkout's Bun 1.4.4 first,
untimed. Report fields record `bunReplaced`.

| Workload | Condition | Wall | Peak MiB (anon / shmem) | PIDs | Outcome |
| --- | --- | --- | --- | --- | --- |
| Browser, 3 × 2 heavy pages | unrestricted | 113 s | 5,463 (3,683 / 0) | 292 | clean |
| | 2 CPU / 4 GiB / 1,024 | 326 s | 4,096 (limit, 18,115 reclaim events) | 294 | clean, 2.9× slower |
| | 8 GiB / 4,096 | 183 s | 5,708 (3,872 / 0) | 282 | clean |
| Browser, 1 × 2 pages | all three | 67–97 s | 1,834–2,014 (≤ 1,394 / 0) | 104 | clean |
| Provider, 3 CLIs × 3 turns | all three | 19.6–20.6 s | 692 (303 / 0) | 57–94 | clean |
| Build: install, typecheck, Vite | unrestricted | 24 s | 4,476 (2,282 / 0) | 168 | clean |
| | 2 CPU / 4 GiB / 1,024 | 35 s (typecheck 15.1 s against 6.5 s) | 4,096 (limit) | 69 | clean |
| | 8 GiB / 4,096 | 25 s | 4,496 (2,304 / 0) | 154 | clean |
| Combined: build, 1 browser, 2 CLIs | unrestricted | 45.0 s | 6,284 (3,476 / 0) | 271 | clean |
| | 2 CPU / 4 GiB / 1,024 | 85.9 s | 4,096 (limit) | 173 | clean, 1.9× slower |
| | 8 GiB / 4,096 | 47.8 s | 5,997 (3,203 / 0) | 263 | clean |

On amd64 the same Chromium pages used no `shmem` at all; a direct write to
`/dev/shm` there is accounted (200 MB showed as 200 MB), so this is a real
platform difference, not a sampler gap. On arm64 Desktop the browser held
up to 1.8 GB of `shmem`. That is more than the 1 GiB `/dev/shm` mount, so it
includes memfd shared memory, which counts against the memory limit as well.

**Enforcement.** All three daemons report CPU, memory and PID support:
Desktop's VM, rootful Engine, and omarchy's rootless Engine (systemd driver,
`cpu memory pids` delegated). On the rootless daemon, a container started
with the default's arguments read `memory.max` 8 GiB, `memory.swap.max` 0,
`pids.max` 4096 and `cpu.max` unlimited. Its throwaway `busybox` image was
removed afterwards, leaving the daemon empty, as it was found. Rootless
without delegation is covered by unit tests: the default creates with no
limits and reports the axes.

**Benchmarks, Docker Desktop 29.9.2 arm64**, 18 CPUs, image
`orkestrator-v2:q0022-arm64`, against the targets in
[container-qualification.md](../../development/container-qualification.md#benchmarks):

| Measure | Target | Built-in default | Unrestricted |
| --- | --- | --- | --- |
| Fresh restricted environment to ready | ≤ 3 s | 2.75 s | 2.56 s |
| Incomplete fresh boots | none | none | none |
| Docker calls per fresh environment | ≤ 21 | 15 | 15 |
| Three concurrent, slowdown | ≤ 1.5× | 1.22× | **1.60×** |
| Warm stop | ≤ 1 s | 0.59 s | 0.61 s |
| Warm start | ≤ 2 s | 1.60 s | 1.62 s |
| 5,000-file copy and verify | ≤ 20 s | 17.5 s | 19.0 s |
| Docker calls per minute, view open | ≤ 36 | 24 | 24 |
| Followers after grace | 0 | 0 | 0 |

The unrestricted run missed the concurrency target once, on the Mac at load
average about 50. Unrestricted is the behaviour before this change, and the
run under the default on the same host met it. Both runs are recorded, not
re-run until they pass. The reference host is Linux Engine amd64; the new
CI step gives a clean comparison there.

## Assumptions and decisions

1. **Shape of the default.**
   - Options: keep budgets opt-in; ship the experiment's fixed preset
     (2 CPUs, 4 GiB, 1,024 PIDs); a fraction of the daemon's capacity; or a
     preset capped at a fraction.
   - Chosen: a preset capped at a fraction. This also answers the old open
     question, "fixed preset or fraction?".
   - Why: the fixed 4 GiB preset broke the heavy browser workload on Desktop
     (OOM kills, page crashes, failed rounds). A pure fraction gives a
     32 GiB Linux host a 24 GiB "budget" that contains nothing. The cap
     keeps a small Desktop VM from being exhausted by one environment.
   - Pros: contains a runaway environment everywhere; never below the
     measured workloads on the default 8 GB VM.
   - Cons: a heavier browser load than the one measured could hit the
     5,888 MiB Desktop default; it would then fail inside its own cgroup
     instead of taking the VM down. The default also differs per machine.
2. **No CPU cap.**
   - Options: 2 CPUs; a fraction of the daemon's CPUs; none.
   - Chosen: none.
   - Why: CPU is compressible and Docker shares it fairly. A 2-CPU cap made
     the browser 1.4–1.75× slower on Desktop. On Linux the 2-CPU, 4 GiB
     budget made the build 1.5× slower and the combined run 1.9× slower,
     with no OOM, so the cost there was the CPU cap. It protects nothing
     that memory and PID limits do not.
   - Pros: no slowdown.
   - Cons: one busy environment can still take CPU from its siblings and
     from the backend on a Linux host. Use an environment budget for that.
3. **Values: 8,192 MiB, 75%, 4,096 PIDs.**
   - Options: 4, 6 or 8 GiB; 50% or 75%; 1,024, 2,048 or 4,096 PIDs.
   - Why: the highest measured memory peak was 6,284 MiB (Linux combined,
     3,476 MiB of it anonymous; Desktop heavy browser 6,046 MiB), so 8 GiB
     covers it with headroom.
     75% of the 7.75 GiB VM still runs the heavy browser cleanly (5,885 MiB
     peak, with reclaim), and leaves about 2 GiB for the daemon and siblings.
     The highest PID peak was 392 (PIDs count threads), so 4,096 gives about
     10×.
   - Pros: matches every measurement.
   - Cons: the margin on Desktop's heavy-browser case is thin. Not measured:
     long agent sessions, other providers, monorepos larger than this one.
4. **A default axis the daemon cannot enforce.**
   - Options: refuse, as explicit budgets are; or drop and report.
   - Chosen: drop and report.
   - Why: refusing would stop every rootless install without delegated
     controllers from creating anything, for a limit the user never asked
     for.
   - Pros: no regression on those hosts, and the gap is visible.
   - Cons: those hosts run without containment.
5. **When the default applies.**
   - Chosen: at create and rebuild only. Existing containers keep what Docker
     applied. Their panel shows the difference, and "apply now" applies it.
   - Why: the todo's rule, and lowering memory under a live container's use
     needs confirmation (`allowBelowUsage`).
   - Cons: old containers stay unrestricted until rebuilt.
6. **The opt-out.**
   - Options: a new `unrestricted` flag; or all-`null` limits.
   - Chosen: all-`null` limits. `parseResourceLimits` and the resolver
     already treated them as an explicit budget.
   - Pros: no schema change.
   - Cons: "no limits" and "a budget with no limits" are the same stored
     value.
7. **Removing the Settings budget.**
   - Chosen: a dedicated `setContainerResourceLimits` setter, the pattern
     `setGitHubCliReminderDismissed` already uses.
   - Why: `updateGlobalConfig` deliberately keeps fields a renderer save
     omits, which also made `null` a no-op.
8. **Mixed versions.**
   - Chosen: `builtInDefault` is optional, and `source: "default"` is new.
   - Effect: a new renderer on an old backend disables "Built-in default"
     and says the backend applies none. An old renderer on a new backend
     labels the default "no limits set" next to the real values.
   - Cons: that old-renderer label is wrong until the client updates.
9. **Provider turns without credentials.**
   - Chosen: the real Claude Code CLI against a loopback mock of the
     Messages API (1 s per response, four real Bash and Read tool calls per
     turn).
   - Why: it measures the CLI's process, tools and streaming without a
     login.
   - Cons: model output is synthetic, and bridges and other providers are
     not covered (left open above).
10. **The Linux image.**
    - Chosen: the host's existing month-old image, with the pinned Bun
      installed in-container for builds.
    - Why: only 12 GB free disk.
    - Cons: the Chromium and CLI versions there are older than this branch's.
11. **Regression reference** (the other old open question).
    - Chosen: one reference host (Linux Engine amd64) with the existing
      targets as the merge gate. Desktop and arm64 numbers are recorded for
      comparison.
    - Why: Desktop met every target under the default, so per-platform
      targets would add a table without changing a decision.
    - Revisit if CI arm64 or Desktop misses repeatedly on a quiet host.

## Constraints and rationale

- No unbounded memory, disk or follower growth, and no daemon-wide work: the
  sampler is owner-filtered and nothing prunes. The workload harness touches
  only containers it labelled `app=orkestrator-workload-budget`.
- Never weaken the separate-candidate-copy guarantee. Running setup against
  the only source volume is not an acceptable shortcut.
- No telemetry of paths, hashes, file contents, commands or prompts;
  benchmark and workload artifacts carry none.
- The regression targets are the merge gate.
- Unknown figures are `null`, never zero. Desktop capacity is the VM's from
  `docker info`, never the backend host's `os.totalmem()`; the default's
  fraction uses the same figure.
- Never lower memory on a live container near its current use without the
  user's confirmation (`allowBelowUsage`).
- Never clear a user's global Docker or cache state to manufacture a cold
  run; the workload harness's cold install uses a fresh container's own
  empty cache.
- Rolling back an optimisation must leave the storage and lifecycle contract
  intact. Rolling back the default is choosing "No limits" in Settings, or
  setting all-`null` limits on an environment.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Desktop and arm64 runs, registry pull time),
  [0020-container-state-observation.md](0020-container-state-observation.md) (per-container
  `docker exec` polling), [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md).
- [Benchmark harness and regression targets](../../development/container-qualification.md#benchmarks),
  [workload budgets](../../development/container-qualification.md#workload-budgets).
- [Container lifecycle](../../architecture/container-lifecycle.md): "Resource
  budgets and usage", "Built-in default" and "Bounded logs".

## Replaces

- `docs/improvements/containers/plan/10-resource-budgets-and-usage-telemetry.md`
  (default budget decision)
- `docs/improvements/containers/plan/11-bounded-logs-and-diagnostic-subscriptions.md`
  (aggregate diagnostic accounting)
- `docs/improvements/containers/plan/12-image-build-and-release-delivery.md`
  (Bun cache mounts)
- `docs/improvements/containers/plan/13-performance-baselines-and-targeted-optimization.md`
  (deferred and rejected candidates and their conditions)
- `docs/improvements/containers/benchmarks.md` (decision table and "Not
  measured here"; the targets moved to
  `docs/development/container-qualification.md`, the one-off baseline numbers
  were dropped)
- `docs/improvements/containers/plan/00-index.md` (measured default resource
  profile gate)
- `docs/improvements/containers.md` (findings 7–9, superseded by #877)
