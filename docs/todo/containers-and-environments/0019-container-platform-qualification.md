# Container platform qualification

Checked against `main` at `06297124` (2026-10-23).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74` (tasks 2, 6 and 7; tasks 1 and 3–5 were last analysed 2026-10-27 at `863b5782`); task 2 run 2026-11-10 against `main` at `04639b12b`.

### Tasks

1. **Record the Linux Engine CI results**: the follow-up to the answered CI question ("record them in this file then, including the C22 host-level reachability verdict"). Status: partly done (CI has run on both architectures; nothing is recorded here, and `container-qualification.md` still says "Not covered: Linux Engine").
2. **Rootless host without `cpu` delegation**: check that the budget read-back stays truthful when only `memory pids` are delegated. Status: done 2026-11-10 (`docker:disposable`'s rootless daemon under a systemd user manager delegated only `memory pids`: Docker reported CPU unsupported, the containers had no CPU controller, and the read-back, admission and refusal all matched; no code change, see [Results, 2026-11-10](#results-2026-11-10-task-2-rootless-without-cpu-delegation)).
5. **Daemon-wide restart during launch and rebuild copy**: a Docker restart or Desktop quit at both points. Status: open (needs a dedicated host or VM).
6. **Container log followers on a live backend after the per-backend move**: a Docker log view streams, its follower exits after the idle grace and with the backend. Moved from to-do 0733 (deleted 2026-11-06). Status: done (2026-11-06 on beelink, native Docker Engine 29.9.2; found and fixed two follower leaks, see [Results, 2026-11-06](#results-2026-11-06-tasks-6-and-7-on-native-docker)).
7. **Fixture restart keeps the container's origin bind on native Docker**: a `dev:test` restart with `--fixture-environments local,container` keeps the same container, and `git fetch origin` still works inside it. Moved from to-do 2180 (deleted 2026-11-06). Status: done (2026-11-06 on beelink, native Docker Engine 29.9.2; three restarts kept the same container and a live origin bind).

### 1. Record the Linux Engine CI results

**Problem.** Linux Engine evidence from the scheduled job is listed as missing, yet the job has run several times. One of its suites is red, and nobody has recorded it.

**Context.** `.github/workflows/container-live-qualification.yml` runs weekly, on demand and on PRs that touch the suites (decision 23). `docs/development/container-qualification.md:185` still says "Not covered: Linux Engine".

**Investigation.** Runs of "Container live qualification" on 2026-10-26, all on `ubuntu-24.04` and `ubuntu-24.04-arm` with Engine 28.0.4:
- **Weekly run 40304582303** on `main` `f1223e0b`: failed only "Live lifecycle (C09, C11, C12, C20)". C20 found no `~/.codex/auth.json` because the runner's uid is not 1000. 0109's relay fixes this.
- **Run 40338400817** (0109 branch): every suite passed, C22 network included.
- **Run 40409285999** (0109 branch head `e53ea683`, now merged): every suite passed except "C14 legacy migration with staged provider inputs" (`apps/backend/tests/container-live-replacement.test.ts:239`). Its precondition reads the raw `/codex-home/config.toml` as `node`, which is unreadable on a non-1000 host; this is a test bug, found in todo 0058's analysis (retired on 2026-10-29) and tracked in [0728](0728-container-ci-c14-assumes-uid-1000.md).

So the next weekly run on `main` should fail only that C14 case. The benchmark numbers from these runs are analysed in [0022](0022-container-resource-budgets-and-performance.md)'s task analysis. They miss the Docker-calls target (26–28 against ≤ 21), and on x64 also fresh-to-ready and warm start.

**Decisions.**

- **What to record, and where?**
  - **One evidence section in `container-qualification.md` (run ids, image digests, pass/fail per suite, the C22 verdict) and a one-line pointer here; replace the "Not covered: Linux Engine" line (recommended).**
    - Pros: the evidence lives in the development doc, as for every other platform; CI artefacts expire, so the facts get copied.
    - Cons: the numbers change weekly; the doc records one snapshot.
  - **Record nothing; treat the workflow history as the evidence.**
    - Pros: no doc churn.
    - Cons: run logs expire after the retention period, and the README wants evidence in the files.
- **Fix the red C14 case before recording?**
  - **Yes: file the C14 precondition fix as a new todo (per 0058's analysis) and record the next green run (recommended).**
    - Pros: the recorded state is a full pass.
    - Cons: waits for one more run.
  - **Record as is, with the failure explained.**
    - Pros: immediate.
    - Cons: records a known-red suite as the Linux baseline.

### 2. Rootless host without `cpu` delegation

**Problem.** On a host that delegates `memory pids` but not `cpu`, the budget read-back must not claim a CPU limit it cannot apply.

**Context.** omarchy-hp's rootless daemon delegates `cpu memory pids`, so it cannot show this case. Unit tests already cover a rootless daemon with only memory delegated (`commands-registry-resource-limits.test.ts`, 0061 item 11). The built-in default drops and reports an unenforceable axis (0022 decision 4).

**Investigation.** 2026-11-06: not run then; it waited for the repo-owned [disposable daemon launcher](../../development/container-qualification.md#disposable-docker-daemon) (to-do 4730, retired 2026-11-10; merged since) rather than hand-building a third private daemon on a shared host. Run on 2026-11-10: see the result below. Explicit budgets are refused on such a daemon by `refuseUnenforceableLimits` (`apps/backend/src/core/container-resources.ts:539-550`), which checks each `capacity.support` axis. Settings warns on save through `unenforceableOnThisDaemon` (0061 item 11). What remains unproved live is whether Docker's own reported capacity on a host like this matches what the cgroup actually enforces.

**Decisions.**

- **How to get such a host?**
  - **A disposable rootless user service on omarchy-hp with a systemd drop-in `Delegate=memory pids`, as the 0109 review run used for its private daemon (recommended).**
    - Pros: no new machine; the user's own daemon and configuration stay untouched; the recipe is proven.
    - Cons: needs the host's free disk (6.2 GB today) for an image; still one host's kernel.
  - **Wait for a user report from a distribution that ships that delegation by default.**
    - Pros: a real-world configuration.
    - Cons: open-ended; a wrong read-back would ship until then.
  - **Accept the unit tests and retire the item.**
    - Pros: refusal and reporting are pure functions of `docker info`, which the tests feed.
    - Cons: assumes Docker reports delegation correctly; this item exists to check that assumption.

**Result (2026-11-10).** Done on beelink, no code change. The launcher's
rootless daemon inherits the delegation of the user manager that runs it, and
beelink's `user@1000.service` delegates `cpu memory pids`, so it was run on a
throwaway systemd "host" instead: a privileged Debian 13 container whose
`user@.service` drop-in resets and narrows `Delegate=` to `memory pids`, where
`user.slice`, `user-1000.slice` and `user@1000.service` all exposed only
`memory pids`. Inside it, uid 1000 ran
`bun scripts/disposable-docker-daemon.ts start --name s0019md` (Docker's static
29.9.2 binaries, the launcher's pinned RootlessKit and slirp4netns). The new
`apps/backend/scripts/rootless-budget-readback-evidence.ts` then ran there:

- `docker info`: cgroup v2, systemd driver, `rootless`; `CpuCfsQuota`,
  `CpuCfsPeriod` and `CPUShares` false with their warnings, `MemoryLimit` and
  `PidsLimit` true. Production capacity: `cpuQuota: false`,
  `memoryLimit: true`, `pidsLimit: true`.
- Built-in default: 8192 MiB and 4096 PIDs, no CPU cap, nothing
  `unenforced` (the default never sets CPU).
- Admission: a 64 MiB, 32-PID budget passed; the same with 0.5 CPU was
  refused (`unsupported-topology`, naming CPU and the rootless remedy).
- A container created with the production arguments: no Docker warning;
  `cgroup.controllers` `memory pids`, no `cpu.max`, `memory.max` 67108864,
  `memory.swap.max` 0, `pids.max` 32. Read-back and the environment policy:
  applied `{ cpus: null, memoryMiB: 64, pids: 32 }`, `unsupported: []`.
- Enforcement: holding 100 MiB was OOM-killed (`oom_kill` 2); forks stopped
  at the limit (`pids.peak` 32, `pids.events` `max 1`); a busy loop got 2.97 s
  of CPU in 3 s, as nothing claimed a CPU limit.
- Asked directly for `--cpus 0.5`, Docker refused the container: `NanoCPUs
  can not be set, as your kernel does not support CPU CFS scheduler or the
  cgroup is not mounted`. So no runtime on such a daemon can carry an
  unenforced CPU limit for the read-back to misreport.

Control, the same script on a `docker:disposable` rootless daemon run
directly on beelink (`cpu memory pids` delegated): `cpuQuota: true`, the CPU
budget admitted, `cpu.max` `50000 100000`, read-back `cpus: 0.5`, and the busy
loop held to 1.51 s in 3 s. Docker's report matched what the cgroup enforced
on both daemons. Recipe and details:
[container qualification](../../development/container-qualification.md#rootless-budget-read-back-without-cpu-delegation-2026-11-10).

### 5. Daemon-wide restart during launch and rebuild copy

**Problem.** Daemon-side effects of a restart (containers stopped, `--rm` helpers killed mid-write) are proved only through a proxy that mimics what the CLI sees.

**Context.** The shared Desktop daemon could not be restarted. The file says to run it on a dedicated host or VM.

**Investigation.** The C15 rebuild-fault suite covers a client-side disconnect mid-copy and kills around the commit. `container-qualification.md:185` lists a daemon restart as not covered.

**Decisions.**

- **Where to run it?**
  - **A new opt-in step in `container-live-qualification.yml` that runs `sudo systemctl restart docker` on the GitHub runner at the two points (recommended).**
    - Pros: runners are disposable and can be restarted freely; repeatable weekly on both architectures; covers Linux Engine, the reference platform.
    - Cons: Docker Desktop's quit path stays unproved; a workflow-level fault is coarser than an in-test hook, so the timing needs a fixture that pauses at the right phase.
  - **A dedicated macOS VM running Docker Desktop.**
    - Pros: covers the Desktop quit, which the file names.
    - Cons: needs hardware or a licensed VM; a manual run.
  - **Keep the proxy evidence.**
    - Pros: no work.
    - Cons: the scenario that loses data in other tools (a helper killed mid-write) stays untested.

### 6. Container log followers on a live backend after the per-backend move

**Problem.** The container log and OOM services moved from module state onto
`BackendRuntime`, so two backends in one process no longer share their
`docker logs -f` followers. Unit tests prove the move; no live backend has
followed a container's logs since.

**Context.** Moved from to-do 0733 (deleted 2026-11-06). `containerLogs` and
`containerOom` are on `BackendRuntime`
(`apps/backend/src/core/backend-runtime.ts`), tested in `backend-runtime.test.ts`
("two OrkestratorBackends in one process"). The idle grace for followers was last
measured live before 2026-10-28 (Qualification, "Log followers after the idle
grace").

**Investigation.** Steps:

1. On a disposable `dev:test` profile with Docker, open a container
   environment's Docker log view and check that lines stream.
2. Close the view and wait past the idle grace. Check with `ps` that no
   `docker logs -f` follower is left.
3. Reopen the view, then stop the profile with `dev:stop`. Check that the
   followers exit with the backend.

**Decisions.**

- **Run it alone or with the next container pass?**
  - **With the next container qualification pass on any Docker host (recommended).**
    - Pros: a few minutes on a profile that is already running.
    - Cons: low value on its own: production runs one backend per process and
      the change only moved where the service is held.
  - **Drop it.**
    - Pros: no work.
    - Cons: the per-backend shutdown path would stay unobserved live.

### 7. Fixture restart keeps the container's origin bind on native Docker

**Problem.** A `dev:test --fixture` restart now reuses the fixture project and
its environments instead of orphaning them. A local-only restart kept the IDs
and inodes live on beelink; the container fixture's bind mount of the fixture
origin has not been checked across a restart on native Docker.

**Context.** Moved from to-do 2180 (deleted 2026-11-06). The reuse is in
`apps/desktop/scripts/dev/fixture.ts` (`fixtureRepositoryIntact`, the
`orkestrator-fixture-environments.json` IDs file), tested in `fixture.test.ts` and
described in [`agent-testing.md`](../../development/agent-testing.md).

**Investigation.** Steps:

1. On a Linux native-Docker host, start a fresh profile with
   `mise run dev:test --profile <p> --fixture --fixture-environments local,container`.
2. Run `mise run dev:stop --profile <p>`, then the same `dev:test` command again.
3. Check that there is still one `fixture-container`, with the same ID and
   status `running`, and that `origin.git` kept its inode.
4. Inside that container, check that `git fetch origin` against
   `/orkestrator-agent-test-origin.git` succeeds. Then `dev:reset` the profile.

**Decisions.**

- **Is the check worth a run?**
  - **Run it once with the next native-Docker pass (recommended).**
    - Pros: the inode was seen to survive a local-only restart, so a pass is
      likely and cheap to show.
    - Cons: low value.
  - **Drop it.**
    - Pros: no work.
    - Cons: a stale bind would surface as a confusing fetch failure in a later
      live suite.

The container lifecycle (durable operations, persistent storage, staged
inputs, per-environment networks, resource budgets, bounded logs) shipped in
#877 with live evidence from Linux Docker Engine 29.7.2 on amd64. The full
live set has since passed on Docker Desktop for Apple Silicon three times
(2026-10-17, and twice on 2026-10-23 with two new fault suites). Provider
session resume after a rebuild is now qualified for every provider except
Grok. A real Linux rootless Engine ran on 2026-10-25: storage and rebuilds
pass there, and its gaps moved to
the to-do 0109, since retired: its
[rootless re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09)
is the evidence, and what it left is in
[7548](7548-rootless-gvisor-tap-vsock-host-loopback.md) and
[7549](7549-rootless-docker-cp-refusals.md). What is still missing needs
hardware, accounts or a host this pass did not have: a daemon-wide restart
and Linux Engine evidence from the new scheduled CI job. The Grok resume and
rotation run and the disposable-account Claude half of C21 need real
provider logins and moved to the manual-test checklist (7568) on
2026-11-10.

## Current state

- Six opt-in live suites run against a real daemon when
  `RUN_LIVE_DOCKER_TESTS=1` and `ORKESTRATOR_QUALIFICATION_IMAGE=<image>` are
  set, all under `apps/backend/tests/`:
  - `container-live-qualification.test.ts`: C09, C11, C12, C20;
  - `container-live-replacement.test.ts`: C14–C19;
  - `container-live-network.test.ts`: C22, C24, C26;
  - `container-live-firewall.test.ts`: C23;
  - `container-live-readiness.test.ts` (new): readiness fault injection,
    C10, the C22 host-service reply and a C23 firewall re-run;
  - `container-live-rebuild-faults.test.ts` (new): a daemon disconnect
    mid-copy, and a kill just before and after the rebuild commit write (C15).

  Every resource carries a per-run label and an owner label derived from a
  private temporary data directory, and `afterAll` removes exactly those
  resources.
- `.github/workflows/container-live-qualification.yml` (new) runs all six on
  `ubuntu-24.04` and `ubuntu-24.04-arm` (a real Linux Engine on both
  architectures): weekly, on demand, and on pull requests that change the
  suites. `tests/unit/ci-workflows.test.ts` fails if a live suite is missing
  from it.
- The benchmark harness is `apps/backend/tests/container-benchmarks.test.ts`
  (`RUN_CONTAINER_BENCHMARKS=1`, C28). `docker/tests/final-image-smoke.sh`
  runs in CI on both architectures (C27).
- Real-stack specs (`test:agent:docker`): `container-rebuild-cycle.spec.ts`
  (C29), `container-settings.spec.ts`, `container-root-terminal.spec.ts`
  (new: **New root terminal**, uid 0, outbound access by network mode) and the
  opt-in live `container-approval-stop.spec.ts` (C11 approval half). `dev:test
  --fixture-network full` (new) creates the fixture container in full network
  mode. `test:agent:browser:isolated` covers the local-worktree regression
  (C30).
- `RESUME_QUALIFIED_PROVIDERS` (`container-replacement.ts`) holds `claude`,
  `codex`, `opencode`, `cursor` and `pi`. Only Grok's resume is still shown as
  unverified. `scripts/qualify-session-resume.sh` is the C13 driver; it now
  takes `QUALIFY_MODEL`, `QUALIFY_REASONING`, `QUALIFY_REQUEST_TIMEOUT` and an
  ambiguous-dispatch phase (`QUALIFY_AMBIGUOUS=1`).
- Rootless daemons are supported with gated features. Every create,
  `update_environment_resources` and the rebuild preflight refuse a budget
  axis the daemon reports it cannot enforce (`refuseUnenforceableLimits` in
  `container-resources.ts`). A restricted firewall that cannot apply fails the
  boot closed. Rootless has been exercised only in a nested `docker:dind-rootless`.
- New scripts: `scripts/measure-registry-image.sh` (compressed sizes,
  blob transfer and a cold pull in a throwaway dind) and
  `scripts/qualify-backend-upgrade-rollback.ts` (real releases over a shared
  data directory).
- A committed stop withdraws the environment's outstanding agent requests
  from the session projection (`withdrawEnvironmentInteractions`).

The commands that reproduce the evidence, the C01–C30 scenario matrix, the
platform dimensions and the benchmark targets are in
[container-qualification.md](../../development/container-qualification.md).
Gaps this pass found but did not fix went into to-do 0061 (retired
2026-11-10); their behaviour is in
[container lifecycle](../../architecture/container-lifecycle.md).

## Results, 2026-11-10 (task 2: rootless without `cpu` delegation)

Host beelink (Omarchy, kernel 7.1.8, x86_64; host Engine 29.9.2), `main` at
`04639b12b`. The run is summarised under [task 2](#2-rootless-host-without-cpu-delegation);
the image recipe, commands and both daemons' figures are in the
[container qualification record](../../development/container-qualification.md#rootless-budget-read-back-without-cpu-delegation-2026-11-10).

- **Topology.** A throwaway privileged systemd container (`--cgroupns=private`)
  on the host daemon, `user@.service` delegating `memory pids` only, with
  `docker:disposable`'s rootless daemon started inside by its uid-1000 user.
- **Result.** Docker reported `CpuCfsQuota: false`, `MemoryLimit` and
  `PidsLimit` true; containers got only the `memory` and `pids` controllers;
  memory and PID limits were enforced; a CPU budget was refused by
  `refuseUnenforceableLimits` and, asked directly, by Docker; the read-back
  showed exactly what was applied. A control daemon with `cpu` delegated
  enforced 0.5 CPU and reported it. No code change.
- **Created and removed.** The systemd image (three builds of one tag), its
  container, the inner daemon `s0019md` and the control daemon `s0019rl`, the
  downloaded `docker-29.9.2.tgz` and the launcher's tools cache. Left: the
  BuildKit cache of those builds on the host daemon, which only a prune could
  remove; the rules forbid one.

## Results, 2026-11-06 (tasks 6 and 7 on native Docker)

Host: beelink (Arch Linux, kernel 7.1.8, x86_64), Docker Engine 29.9.2
rootful, cgroup driver `systemd`. Branch
`docker-platform-qualification-b566b507597f-r1` from `main` at `c1724ab74`.
One isolated profile, `q0019-docker`, started headless with the scoped
Docker shim (the address pool was not exhausted; the shim was used so the
run matches `test:agent:docker:isolated`) and
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" \
  PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" \
  mise run dev:test --profile q0019-docker --fixture --fixture-environments local,container \
  --no-agent-credentials --agent-platforms codex --headless
```

The log view was driven with Playwright against `browserUrl` (environment
settings → Container → Container log → Show/Hide). A marker line was written to
the container's PID 1 stdout to prove live streaming, and followers were
counted with `ps` by the fixture container's full ID. The profile was reset
with `dev:reset` afterwards (2 containers, 2 volumes and 1 network, all with
the profile's owner label).

### Task 6: log followers

| Check | Before the fixes | After the fixes |
| --- | --- | --- |
| View streams | Pass: the marker appeared about 1 s after it was written | Pass: about 1 s |
| Follower exits after the idle grace (5 s) | **Fail**: the follower was still running 180 s later, reparented to systemd | Pass: gone 5.04 s and 5.10 s after Hide |
| Followers exit with `dev:stop` | Pass (log follower and the OOM `docker events`) | Pass: 6 follower processes before, 0 after |
| Followers exit when the backend is SIGKILLed (added check) | **Fail**: `docker logs -f` reparented to systemd and was still running 64 s later; the parent-bound OOM watcher exited | Pass: all gone within 200 ms |

Two defects, both fixed with tests:

1. **The scoped Docker shim orphaned every follower it relayed.**
   `docker-qualification-bin/docker` ran `bun docker-qualification.ts`, which
   ran the real CLI with `spawnSync`. The backend's SIGTERM stopped bun and left
   `docker logs -f`, the OOM `docker events` and terminal `docker exec -it`
   sessions running under systemd. Production does not use the shim, but every
   `test:agent:docker:isolated` run and every manual profile started as 7041
   describes did. The shim now `exec`s the real CLI for every call except
   `network create`. Test: `docker-qualification.test.ts` ("execs the real
   CLI"), which fails on the old shim because the PID that answers is Docker's
   child rather than the shim's.
2. **The container log follower was not parent-bound.**
   `ContainerLogService` spawned `docker logs -f` with plain `spawnCommand`,
   unlike the OOM watcher, which has used `spawnParentBoundCommand` since #1301.
   A SIGKILLed backend runs no shutdown, and a quiet container writes nothing
   that would raise SIGPIPE, so the follower lived until the container next
   logged or stopped. It now uses `spawnParentBoundCommand`. Test:
   `container-log-service.test.ts` ("a follower does not outlive a SIGKILLed
   backend") runs the real service in a child Bun process with a fake `docker`
   on PATH, SIGKILLs it and requires the follower to exit. It fails on the old
   code.

The per-backend move itself behaved as designed: each backend's followers
were its own children, and `dev:stop` (SIGTERM, `shutdown()`) ended them.

### Task 7: fixture restart keeps the origin bind

The profile was restarted three times over the same fixture: after `dev:stop`,
after a SIGKILLed backend (the launcher exited with it), and after a second
SIGKILL.

- Every restart reused `fixture-local` (`e1cd9676…`) and `fixture-container`
  (`03c9558d…`) from `orkestrator-fixture-environments.json`. The backend
  listed one project with exactly those two environments, both `running`.
- There was one runtime container, `0b4977a6da4a`, `running`, with the same
  `StartedAt` (03:48:20 UTC) and `RestartCount` 0 throughout. It was neither
  recreated nor restarted, because `seedFixture` skips a running environment.
- `origin.git` kept inode 25131863 on the host. Inside the container
  `/orkestrator-agent-test-origin.git` showed the same inode and was still a
  read-write bind of that path.
- `git fetch origin` in `/workspace` succeeded after each restart, and
  `origin/main` matched the host's `main` (`f0018d8`). A commit pushed to the
  host `origin.git` after a restart (`b2932b6`, branch `q0019-bind-check`) was
  fetched inside the container, so the bind is live rather than a stale copy.

## Results, 2026-10-23

Source `06297124` (`main`) plus this change. Host: macOS 27.0, Apple M5 Pro,
18 CPUs, Docker Desktop 4.95.0 (Engine 29.8.2, API 1.56, linuxkit 7.0.14,
`linux/arm64`, VM 8.3 GB). Image `orkestrator-v2:dev-0e7293c379f3`
(`sha256:18aae7894d756cee1a5e6af1d29b33035c9644bddc2726fc1e48fec5d35572d6`),
manifest source revision `06297124`, app version 2.26.3-beta, built with
`mise run docker:build:dev`. Everything was native arm64. Other environments
shared the host and daemon: load averages were 20–93 for the first session
(00:48–03:10 BST). The host then rebooted, which deleted the `/tmp` evidence
of that session; the C13, registry, upgrade/rollback and benchmark figures
below were re-run afterwards (09:54–10:40 BST, load 5–124). Every product
fix below has a unit test that fails without it.

### Live suites (first session)

| Suite | Result |
| --- | --- |
| `final-image-smoke.sh` | Pass (CLI versions, five bridges' `/global/health`, Codex code-mode host, Chromium) |
| Lifecycle | 6/6. The first baseline was 5/6: the C20 fixture still used a Codex `auth.json` of `{"fixture":true}`, which staging now withholds as holding no login (#1114). Fixture fixed |
| Replacement | 10/10, three times (baseline, final, and after the shared fixture moved to `container-live-workspace.ts`) |
| Network | 4/4 |
| Firewall | 2/2. One run leaked two networks: Bun's 5 s default `afterAll` timeout cut cleanup short under load. The lifecycle, network and firewall suites now give `afterAll` 180 s; rerun clean |
| Readiness (new) | 8/8, twice. Both restart branches were seen |
| Rebuild faults (new) | 5/5, twice (after the two fixes below) |
| `test:agent:docker`, full-network fixture | 11 passed, 2 opt-in skips (second run; the first had two load timeouts, flakes 0506 and 0518) |
| Root terminal, restricted fixture | 1/1 |

Readiness faults, each injected through a test fixture (a derived image, an
adopted `--internal` network, a held boot) and each refused as a typed,
retryable `not-ready` with no setup, no agent launch and the launch intent
cleared: missing firewall script, DNS and bootstrap failure, an unwritable
status directory, a torn status write plus a stray temporary record (timed
out, never `ready`), and a `docker restart` of the container during launch
(the earlier boot is never accepted). A firewall re-run that loses DNS fails
closed: 10–12 samples during the re-run were all blocked and the policy
reports `failed`. C10: with setup killed after its side effect, the
environment is marked failed, nothing launches, and the side effect happened
exactly once after a wait and after a restart. C22: the real agent-tools
server answers from inside the restricted container (HTTP 405 to a GET, 200 to
an authenticated `tools/list`) and another host port is refused.

Rebuild faults: a Docker API proxy on a unix socket, pointed to by
`DOCKER_HOST` in the test process only, cut an archive stream after 8 MiB, cut
a copy helper as it started, and spanned the whole copy phase. Each time the
original stayed authoritative and byte-identical, the candidate set was kept
as one `failed-candidate` copy, reconciliation found nothing unresolved, and
exactly one authoritative set existed. A child process parked just before and
just after the commit write and was killed with SIGKILL: before commit,
reconciliation settled the operation as interrupted and removed the
candidate; after commit, the candidate was authoritative and the source kept
as a recovery copy. Workspace bytes, Git state, provider state and SQLite rows
matched throughout.

### Problems found and fixed

1. **A daemon outage could commit an empty rebuild candidate** (data
   integrity). `pipeContainerPath` treated any "no such file" as an absent
   source path, and the CLI's own error for a missing daemon socket says
   exactly that. Reproduced live: a migration committed with `files: 0`. Only
   the daemon's `Could not find the file` now means absent.
2. **A rebuild could hang forever** when `docker cp` and its helper lost the
   daemon together: the producer's paused output never reached EOF. Reproduced
   live and with fakes (3 of 5 hung). The producer's output is now drained once
   the consumer is gone.
3. **A fail-closed boot surfaced as an untyped error.** A root `docker exec`
   that repairs `/project-files` access ran before the readiness wait, so a
   boot that exited at once reported "container is not running" and failure
   code `unknown`. It now runs after readiness.
4. **Rootless budgets were silently weakened.** A rootless daemon without
   cgroups accepts `--cpus/--memory/--pids-limit` with no warning, records
   them, and enforces nothing; the read-back then showed them as applied. Such
   budgets are now refused before anything is created or stopped.
5. **A stopped environment's dead approval was still reported as pending** by
   the public CLI (`session get`, `session interactions list/resolve`) and the
   coordinator's `get_tab_state`. A committed stop now withdraws it.
6. **Cursor could not run in restricted containers**: the allowlist lacked
   `api.cursor.com`. Added to Cursor's required hosts.
7. **Changing the Cursor key during a turn killed the container bridge**,
   losing the turn and wedging the session. A busy bridge now keeps its key
   until idle, as Claude and Codex already did.
8. **OpenCode's first prompt after a rebuild was refused** ("OpenCode status
   is unavailable"): a new container reinstalls OpenCode's plugin
   dependencies on its first request, which outran the 30 s status timeout.
   A fresh container's OpenCode server now loads `/workspace` (best effort, up
   to 120 s) before the start returns.
9. **A read-only backend still deleted containers and pushed allowlists.**
   Under a data-directory marker that requires a newer writer, every
   lifecycle operation was refused, but `delete_environment` removed the
   container, its volumes and its network, and the allowlist commands changed
   a running container's firewall. Found by the upgrade/rollback harness on
   both `main` and the v2.21.0 floor. Both now need the registry writer;
   the saved allowlist still stands and reports as not yet enforced.

### Rootless (nested, not a Linux host)

`docker:dind-rootless` (Engine 29.9.2) ran privileged inside Desktop,
Unix-socket only, with no systemd. `docker info` reported `name=rootless`,
cgroup v2, cgroup driver `none` and CPU, memory and PID limits unsupported;
`parseDockerInfo` read all of that. A container created there with `--cpus 1
--memory 512m --pids-limit 256` exited 0 with no warning and ran 457
processes against `pids.max = max`; `docker update` failed with a raw runc
error. The product, driven against that daemon through a `docker` shim,
reported the topology as rootless and refused the budget with zero `docker
create` calls. The real image in restricted mode (policy 3) reached `ready`
with egress, allowed hosts answered and `example.com`, `www.google.com` and
port 80 of an allowed host were refused; `node` could not change the rules.
With no egress, or without `NET_ADMIN`, it exited `firewall-failed`. What does
not transfer to a Linux host is listed under the rootless item below.

### C13 provider resume (09:54–10:15 BST)

Profile `q0019-resume` (all five credential sources), image above. Each
provider ran the driver twice through `test:logged`, each pass a rebuild onto
a new runtime generation followed by the codeword recall:

| Provider | Result | Generations | Ambiguous dispatch |
| --- | --- | --- | --- |
| Codex | Pass, twice | 1→2, 3→4 | Pass (2→3) |
| OpenCode | Pass, twice | 4→5, 5→6 | Not run |
| Cursor | Pass, twice | 1→2, 3→4 | Pass (2→3) |
| Pi | Pass, twice | 4→5, 6→7 | Pass (5→6) |
| Grok | Skipped: the host login expired about 64 h earlier and the launcher withheld it | | |

- Codex needed `QUALIFY_MODEL=gpt-6-luna`, and Pi `openai/gpt-6-luna`: their
  defaults are refused for a ChatGPT-account login, and that refusal never
  reaches the transcript. That is what the first attempt saw as "turns
  finished with no assistant message".
- Codex's relocated `CODEX_SQLITE_HOME` databases: the session's thread row
  survived each rebuild, its turn count went from 1 to 2 after the follow-up,
  and `quick_check` was ok throughout.
- OpenCode needed `opencode.ai` in that environment's allowlist for its
  default providers (follow-up in 0061), and the first-prompt fix above.
- Ambiguous dispatch: inside the container, a rule dropped only prompt
  requests to the agent's bridge; a prompt was sent and the environment
  rebuilt while it was in flight. Right after and 60 s later the CLI answered
  `dispatch-unknown` (exit 7), `recoverableDispatch` stayed `action-required`
  with the same request id, no reply or saved provider state held the
  prompt's codeword, and a new prompt was refused `dispatch-parked`.
- Host Codex, OpenCode, Pi, Grok and Cursor credentials had the same SHA-256
  prefix and mtime before and after.

### C21 rotation (first session)

Profile `q0019-rotation` with Claude, Cursor and Grok sources. Host
credential files were unchanged before and after, and the Keychain was never
read.

- **Claude.** On macOS the host login comes from the Keychain, so it cannot be
  redirected to a disposable copy. Instead two disposable added accounts held
  copies of the container's own access-only login (no `refreshToken` key
  anywhere). Every step passed: the start sync wrote mode 600 with no refresh
  token; a login rewrite during a 2,500-number turn was pushed without
  disturbing the turn; the keeper delivered a rewrite within its 5-minute pass
  with no command; a durable `loginGeneration` replaced the idle bridge;
  switching to account B under a running turn left the busy bridge on A, then
  pushed B once idle and the session recalled its codeword; a restart
  restaged B's rotated login with no `.partial` or `.tmp`; switching back to
  the host login worked.
- **Cursor.** The key file was mode 600, matched the profile's copy, was
  re-synced on every bridge start and after a restart. The two Cursor fixes
  above were found here and re-run live.
- **Grok.** Skipped: host login expired.

### Benchmarks (09:54–09:58 BST)

Run `bmvkqhqp7`, same image, load average 18 at start (other agents running).
Every target was met:

| Measure (median) | Target | Result |
| --- | --- | --- |
| Fresh restricted to ready | ≤ 3 s | 2.31 s |
| Incomplete fresh boots | none | none |
| Docker calls per fresh environment | ≤ 21 | 15 |
| Three concurrent, against the sequential median | ≤ 1.5× | 1.11× |
| Warm stop | ≤ 1 s | 0.58 s |
| Warm start to ready | ≤ 2 s | 1.53 s |
| Rebuild copy and verify, 5,000 files (100 MB) | ≤ 20 s | 11.2 s |
| Docker calls per minute, Docker view open | ≤ 36 | 24 |
| Log followers after the idle grace | 0 | 0 |

The 200-file rebuild took a median of 5.0 s in total; the usage sampler took
2.0 s for 8 running environments with 3 Docker calls.

### Registry (09:54–10:00 BST)

`scripts/measure-registry-image.sh`, anonymous pulls from
`ghcr.io/orkestrator-ai/orkestrator-v2`, this host's home network:

| Tag | Index digest | arm64 compressed | amd64 compressed | Blob transfer (arm64) | Cold `docker pull` (arm64, fresh dind) |
| --- | --- | --- | --- | --- | --- |
| 2.23.0 (stable) | `sha256:262fff6c…b194` | 1,782,722,541 B, 64 layers | 1,794,129,157 B | 32.3 s (55.1 MB/s) | 43.0 s |
| 2.26.3-beta | `sha256:118dc797…569f` | 1,783,255,709 B, 65 layers | 1,794,635,846 B | 40.4 s (44.2 MB/s) | 39.8 s |

Uncompressed the image is 5.97 GB (about 3.35× the compressed size). The
largest layers are 451, 319 and 232 MB. Under load up to 72, before the
reboot, the 2.23.0 cold pull took 95.7 s. The `image-release.json` artifacts
of 2.23.0 and 2.26.3-beta match the registry and the tag commits. The
2.21.0–2.22.3 publish runs failed at "Create and verify multi-architecture
manifest", so those tags were pushed without a recorded digest.

### Upgrade and rollback with real releases

`scripts/qualify-backend-upgrade-rollback.ts` runs each release's own
headless backend from a detached worktree over one private data directory,
drives it through `/__orkestrator/invoke`, and snapshots every file, store
row, lifecycle record, owned container, volume and network, workspace hash
and firewall policy.

- **Rollback floor:** v2.21.0. The schema marker arrived in `1cdba8e0c`,
  but no 2.19.x or 2.20.x was ever tagged or published, so the floor is also
  the oldest real release. A pre-floor upgrade cannot be run from real
  artifacts; the harness uses v2.21.0's own `legacy-layer` storage instead.
- **Upgrade (current backend over v2.21.0's directory):** environment and
  lifecycle records, every container, volume and network, running workspace
  contents, network policy and the marker were unchanged; the legacy
  environment is reported as `legacy-layer` and not migrated. The SQLite store
  itself is migrated from v3 to v4 on first start, with a pre-migration
  backup, as `docs/architecture/storage.md` documents.
- **Rollback (v2.21.0 over a directory the current backend wrote):** v2.21.0
  refuses to start (`Storage database schema version 4 is newer than this
  build supports (3)`), and nothing changed. Store v4 first shipped in
  2.24.0-alpha, so every release up to the stable 2.23.0 is locked out after
  any later release opens a directory. The marker's read-only mode is not
  reachable between real releases today: the writer version is still 1.
- **Read-only mode, with a planted marker requiring writer 2:** v2.21.0 and
  the current backend refused start, provision, stop, every rebuild, applied
  resource changes, raw start and stop, and operation resolution. Delete and
  the allowlist commands went through: problem 9 above.
- **After the fix (10:16–10:23 BST, load 46–143, `--main-ref` at this
  change):** in read-only mode the current backend refused both deletes, and
  its owned containers, volumes, networks, running workspaces and firewall
  policy were unchanged. What it still accepted were writes to records and
  configuration only: the saved allowlist (reported as not enforced), a port
  edit, the global resource limits, a background start that recorded its own
  failure, and a reviewed cleanup that answered `conflict` for all 18
  resources. The harness counts those as mutations, so it still exits 1
  (39/47); none touches Docker. v2.21.0 keeps the gap, as it predates the
  fix. Evidence: `/tmp/q0019/upgrade-fixed.log` and the report JSON beside it.

### Repository checks

`mise run format:check`, `mise run lint` and `mise run typecheck` passed.
`mise run test` (1,199 s, load 12–60) passed the root, bridge and codex
protocol groups. The workspace group failed two tests this change does not
touch: `move_environment > moves a worktree with nested submodules (copy)`
(five-second timeout, passed alone; flake 0621) and the Firefox executable
document policy test, which also fails intermittently on unchanged `main`
(flake 0697). Every new suite skips cleanly without its opt-in variables.

### Multi Review (2026-10-23)

The review returned five findings and four test-coverage gaps; a Fix session
addressed all of them (`c2006a52b`), and they were then checked here:

- The rootless flag from the topology probe was kept only at create. The
  rebuild preflight, the recovery-copy restore and `update_environment_resources`
  read `dockerCapacity()` alone, so a capacity probe that failed under load
  dropped the rootless flag and let an unknown budget through. All four now
  use `dockerAdmissionCapacity`, which carries the topology's rootless flag.
- A recovery-copy restore refused an unenforceable budget only after it had
  quiesced the current runtime. It now refuses first (formerly follow-up
  item 12).
- The stop fence bumped the epoch only for projections that listed a pending
  request. An empty or not-yet-cached projection with a refresh in flight could
  still commit a request read before the stop. Every key with a cached
  projection or a refresh in flight is now fenced.
- An on-demand pending-interaction read in flight during the stop could cache
  the dead request again. Reads in flight are now marked withdrawn and answer
  from the withdrawn projection; cached reads for the environment are dropped.
- The readiness doc said nothing runs in the container before readiness; the
  Codex account-marker write does, best-effort and with failures logged. The
  doc now says so.
- Coverage added: the readiness ordering for ready, failed and legacy boots
  (`commands-environment-readiness.test.ts`), the restore preflight
  (`recovery-copies.test.ts`), the rootless flag surviving a failed capacity
  probe (`container-resources.test.ts`), and the stop fence across pending,
  empty and absent projections in both representations.

Nothing was rejected. The fence also re-commits a projection whose list was
already empty, adding one revision per session per stop; that keeps the cache
entry on the bumped epoch, so it was kept. Merging `main` (`459d2944`) moved
this code into the collaborators of #1180: the pending-read half now lives in
`NativeAgentInteractionTracker.withdrawEnvironment` and the projection half in
`NativeAgentTranscriptProjection.withdrawEnvironmentInteractions`, joined by
`NativeAgentService.withdrawEnvironmentInteractions`.

## Results, 2026-10-17

Commit `31d0fb06` (`main`). Host: macOS 27.0, Apple M5 Pro, 18 CPUs, 64 GB.
Docker Desktop 4.93.0 (Engine 29.8.1, API 1.56, linuxkit 7.0.14,
`linux/arm64`); the VM reports 18 CPUs and 8.3 GB, cgroup v2, with CPU, memory
and PID limits supported. Everything ran natively on arm64; nothing came from
emulation.

The qualification image was the workspace's isolated development image
`orkestrator-v2:dev-b4d6266ccb00`
(`sha256:3f4603f57e80d06b9799aa91bdf9ae421cb51a3e0c72e01cd180cddc4269457c`),
built with `mise run docker:build:dev --profile cq8efe-docker`. Its manifest
records source revision `31d0fb06`, app version 2.21.1, `network-policy=3`,
`persistent-workspace=1` and `claude-state-signal=2`. The real-stack profile
was `cq8efe-docker`, started with `--fixture --fixture-environments
local,container --credential-source claude`. Nine other environments were
running tests on the same host and daemon throughout, at a load average of
15–27.

| Suite (command) | Scenarios | Result |
| --- | --- | --- |
| `bash docker/tests/final-image-smoke.sh <image>` | C27 (arm64 half) | Pass: CLI versions match the manifest, all five bridges answer `/global/health`, Codex's code-mode host and Chromium work |
| Live lifecycle (`container-live-qualification.test.ts`) | C09 (2), C11 drain, C12 (2), C20 | 6/6 pass (first run 4/6, see below) |
| Live replacement (`container-live-replacement.test.ts`) | C14 (2), C15/C16 (5), C17/C18 (2), C19 | 10/10 pass |
| Live network (`container-live-network.test.ts`) | C22, C24 (2), C26 | 4/4 pass (first run 0/4, see below) |
| Live firewall (`container-live-firewall.test.ts`) | C23, policy-3 tuples | 2/2 pass |
| Benchmarks (`container-benchmarks.test.ts`) | C28 | Three runs; see the table below |
| `test:agent:docker` | C29, container settings (desktop and narrow), foreign-profile refusal, Playwright as both container users | 5/5 pass |
| Live approval (`container-approval-stop.spec.ts`) | C11 approval half, Claude | No run granted the approval. With the layout fix, 3 of 5 runs passed end to end; the other 2 showed Connection Failed after the restart. After the review fix (`99263373`), 4 of 4 runs passed (see below) |
| `test:agent:browser:isolated` | C30 | 25 passed, 15 opt-in skips, 1 failed: the narrow host picker, known flake [0224](../../tests/flaky-tests/previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md), which passed alone. Every local-worktree scenario passed |

After the fixture fix, the live suites ran twice each, both clean: once
through `mise run test:logged` (Bun 1.4.3) and once directly with Bun 1.4.2
from `PATH`, which printed the per-test counts. Nothing was skipped.

On Desktop specifically:

- C22 passes without the host-gateway alias, which `createDockerContainer`
  adds only for a Linux Engine. IPv6 is reported `blocked` or `disabled`
  (the assertion accepts either and does not print which). Siblings are refused by
  their IP, through the environment gateway and through a port a sibling
  publishes. Only the service port leaves the container.
- `get_docker_capacity` reports the VM (`operatingSystem: "Docker Desktop"`,
  8.3 GB), not the Mac's 64 GB. The preserving rebuilds in C14 and the
  benchmarks passed their capacity preflight.
- Volume sub-path mounts work (Engine 29.8.1 ≥ 26): C12 mounts every
  `PROVIDER_STATE_LAYOUT` path from the storage set.
- The host has Homebrew GNU `tar` and `date`, which the shell fixtures prefer
  (#988). Hosts without them were not tried.

### Benchmarks

The targets are from [container-qualification.md](../../development/container-qualification.md#benchmarks).
Run 1 used Bun 1.4.2 from `PATH`; runs 2 and 3 used the pinned 1.4.3 (`mise
exec`). All three ran with nine other environments active.

| Measure (median) | Target | Run 1 `bmvbp5040` | Run 2 `bmvbpaj1e` | Run 3 `bmvbpgt1f` |
| --- | --- | --- | --- | --- |
| Load average at start | | 26.7 | 19.6 | 23.8 |
| Fresh restricted to ready | ≤ 3 s | 1.98 s | **3.33 s** | 2.42 s |
| Incomplete fresh boots | none | none | none | none |
| Docker calls per fresh environment | ≤ 21 | 14 | 16 | 15 |
| Three concurrent, against the sequential median | ≤ 1.5× | 0.89× | 0.95× | 1.13× |
| Warm stop | ≤ 1 s | 0.58 s | 0.60 s | 0.60 s |
| Warm start to ready | ≤ 2 s | 1.13 s | 1.68 s | 1.52 s |
| Rebuild copy and verify, 5,000 files (100 MB) | ≤ 20 s | 13.1 s | 16.3 s | 10.5 s |
| Docker calls per minute, Docker view open | ≤ 36 | 24 | 24 | 24 |
| Log followers after the idle grace | 0 | 0 | 0 | 0 |

Run 2 missed the fresh-environment target by 0.33 s. Every phase of that run
was uniformly slower than run 1 (storage +39 %, create +35 %, start to ready
+83 %), while the median Docker call count barely moved (14 to 16). That
pattern points to
host contention rather than a regression, and run 3 was back within target.
The figures need a quiet host before they can count as a clean baseline.
Other figures: the 200-file rebuild took a median of 4.2 s, 7.2 s and 4.5 s in
total; the usage sampler took about 2.0 s for 8 running environments, with 3
Docker calls; observer churn left 0 followers, with no RSS growth.

### C11 approval half (Claude, real provider)

The spec opens a Claude tab in the fixture container and starts it in **Build**
mode with approvals set to **Ask**. The prompt is `touch
/workspace/.c11-approval-<n>`. Then it switches to `fixture-local` and stops
the container from the sidebar. It returns to the stopped view, starts the
container there and waits for the session to reattach. Observed states:

| Phase | Backend projection | UI |
| --- | --- | --- |
| Asked | `command-approval: pending` | Approval card shown |
| Stopped | `command-approval: pending` (last snapshot; the bridge and CLI were drained) | — |
| Stopped view opened | `command-approval: pending` | "Container is not running / Start Container"; no agent tab, no approve or deny button |
| Started, session reattached | no interactions; turn `idle` | The Claude tab is back; no approval card |

The marker file never existed, and no interaction ever reached `resolved`.
Every run checked the marker while the approval was pending. The passing runs
checked it again after the restart. Of the two that failed at the reattach,
the later one was checked by hand in the container afterwards, and its marker
was absent. The other one's container had been rebuilt by the next spec
before it could be checked.
The approval was withdrawn by process death and never granted. Claude's bridge
has no SIGTERM handler, so it neither denied nor withdrew the request
explicitly. The architecture doc used to claim that bridges "deny or withdraw
on the way out"; it now describes the actual behaviour. The stale `pending`
in the projection while stopped is not reachable from the stopped view; an
outstanding item below checks whether any other surface reads it.

In 2 of the 5 runs with the layout fix, the restored Claude tab showed
**Connection Failed — Unable to connect to Claude** after the start. No error
text was shown and nothing retried automatically. Meanwhile the Claude bridge
in the container answered `/global/health`, but the backend projection stayed
`null`. The first diagnosis blamed a read racing the bridge start. The Multi
Review found the actual cause: `paneLayoutStore.reset` called
`cleanupTabResources`, which requests `teardownTab` for native and tmux tabs.
With the bridge stopped, that teardown could not complete. It stayed as a
pending intent ("Tab teardown remains pending … bridge is unavailable" appears
in the backend log for these runs' tabs). The periodic teardown sweep then
closed the session once the restarted bridge answered. A `null` read follows,
which `useNativeAgentSession` treats as "no session"
(`useNativeAgentSession.ts:2488-2491`), so the controller shows the error
state (`AgentNativeTab.controller.tsx:2090-2101`). The intermittency is the
sweep's 60-second schedule. `99263373` makes `reset` release local views only,
so no teardown intent is created. The spec now forces
`reconcile_tab_teardowns` after the restart, sends a follow-up turn and checks
that the provider session mapping is unchanged. It passed in the Fix session's
run and in 3 of 3 runs on the merged branch (load average 15–20). If
Connection Failed comes back after a restart without a pending teardown
intent, reopen this as a bridge-start race.

Also seen on this host: the backend's reachability probes from inside the
container got `outcome=reachable http=405` from
`http://host.docker.internal:<port>/mcp`. So on Desktop the agent-tools port
is actually answered, not merely left the container. That is evidence for the
C22 live host-service item below; it was not checked by a dedicated run.

### Problems found and fixed

1. **Live-suite fixture drift.** The first lifecycle run failed C12
   (backend-created runtime) and C20. The first network run failed all four
   tests, and the benchmark harness had the same gap. Each failed with
   `context.storage.loadAgentAccounts is not a function`, because
   `createDockerContainer` has resolved the active account since #889
   (`agent-accounts-containers.ts:91`). The replacement and firewall suites
   had their own inline stubs. The empty account store now lives in the shared
   `memoryLifecycleContext` (`apps/backend/tests/container-lifecycle-fixtures.ts`),
   and the two inline copies are gone.
2. **Agent tabs vanished when a stopped container was started from its own
   view.** `TerminalContainer.view.tsx` resets the renderer's panes when the
   container stops. `paneLayoutStore.reset` emptied the layout but left the
   environment's hydration marked `done`. On the next start the seeding effect
   saw no tabs and added a default "Terminal 1" instead of restoring the
   persisted layout. The backend refused to write that terminal over the
   durable layout ("Pane layout intent targets stale environment generation:
   expected <container id>, received local"), so a reload brought the tab
   back. `reset` now also clears the hydration marker, so a restart re-reads
   the backend layout. The regression test is "restores the persisted layout,
   not a default terminal, when a stopped container starts again" in
   `TerminalContainer.view.test.tsx`; it fails without the fix. The live C11
   spec covers the same path.

### Pane reset review follow-up, 2026-10-17

Validated the review fixes on top of `309f7a5d` in
`todo-container-live-qualification-8efe5278910a-r1`, using the disposable
profile `qa-pane-reset-review` (Docker Desktop 29.8.1, macOS arm64). Runtime
reset now releases local views without requesting native/tmux tab closure.
Stopping during the first pending hydration also clears it; request identities
prevent its late response from settling the next start's restore.

- The focused pane store, persistence, TerminalContainer and resource-sync
  tests passed through `test:logged` (`--name reset-final`, one Bun worker).
  Coverage includes native stop/start, replacement container IDs, a stale
  pending hydration, and suppression of the reset's empty persisted layout.
- `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pane-reset-review ORKESTRATOR_AGENT_TEST_DOCKER=1 ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1 mise run test:logged -- --name c11-live-reselect -- mise run test:agent:browser -- e2e/agent-testing/container-approval-stop.spec.ts`
  passed (one test, 85.3 s). The fixture had no prior pane layout. The browser
  used the profile's loopback gateway at 1440×1000. It stopped/restarted the
  container from its own stopped view after switching away, retained the
  original native mapping, forced teardown reconciliation, completed another
  turn while inactive, and reopened/reloaded the native tab. Cleanup confirmed
  both the layout and mapping were absent. The first run reached the completed
  follow-up turn but failed because reload returned to the unselected workspace;
  the spec now explicitly selects the environment after reload. Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.RlXZkp/c11-live.log.gz`.
- `ORKESTRATOR_AGENT_TEST_PROFILE=qa-pane-reset-review mise run test:logged -- --name docker-fixture -- mise run test:agent:docker`
  passed (five tests, one live-provider opt-in skip, 61.1 s). The live case
  was already run separately above. Results are under
  `output/agent-testing/qa-pane-reset-review/browser/`.
- Format, lint, full typecheck, the flaky-register test and the backend
  retaining-close tests passed. The broad repository/browser runs also hit
  unrelated failures, recorded in the flaky-test register (0165, 0174, 0178,
  0194, 0210, 0226 and 0278). Pi runtime staging also timed out on both owning-file
  reruns, so this validation does not establish a fully green repository suite.
  The full suite finished in 565.3 s: web passed 7892 tests (10 skipped),
  backend reported four failures and one late error, root one failure, and
  bridges one failure. Full evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XKPva3/`
  (outer logged artifact `orkestrator-test-run.XD6iJX/full-suite.log.gz`).

`dev:stop` and `dev:reset` completed for this profile; no launcher was retained.
Reset removed two exact-owner containers, four volumes, one network and the
disposable profile state. No Electron-only or iOS behavior changed; those
scenario suites were not selected.

3. **A stop's pane reset closed native sessions after the restart.** Found by
   the Multi Review and fixed in `99263373`; the diagnosis is in the C11
   section above. The reset also cancels pending layout writes, and a
   hydration request from before the stop can no longer settle the restore
   the next start begins.

Seen but not fixed: a dev or agent-test profile shows "Orkestrator has been
updated … the server now runs 44.7.0". The dev launcher starts Electron on a
bare script (`apps/desktop/scripts/dev/lifecycle.ts:629`), so
`app.getVersion()` returns Electron's own version, and that becomes
`ORKESTRATOR_VERSION`. Tracked in
[0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).

### Decisions

1. **Qualification image.** Options: an existing image from earlier in the
   day, a separate `docker/build.sh` tag, or the profile's development image.
   We used the development image built from `31d0fb06`. One image id then
   serves the live suites, the benchmarks and the real-stack run, and its
   manifest proves the source revision. `orkestrator-v2:latest` was never used.
2. **Fixture drift.** Options: an inline stub in each failing suite (matching
   replacement and firewall), or one default in the shared fixture. We chose
   the shared default, which fixes all three and stops the next suite from
   drifting the same way. Suites can still override it with `Object.assign`.
3. **C11 approach.** Options: drive the browser by hand, write a backend-only
   script, or add an opt-in Playwright spec. We added the spec, gated on
   `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1`, so the evidence can be
   reproduced and the real user path (sidebar stop, stopped view, start) is
   the one exercised.
4. **C11 provider.** Only Claude was qualified, because the profile authorized
   only Claude credentials. Codex, OpenCode, Pi, Cursor and Grok approvals
   under a stop are not claimed.
5. **Stale `pending` while stopped.** Options: mark the request `withdrawn`
   in the backend when the stop commits, or document the behaviour and verify
   other surfaces first. We documented it and added an outstanding item,
   because the stopped view cannot show or answer the request.
6. **Benchmarks under load.** Options: wait for a quiet host, or record three
   runs with their load averages. We recorded the runs. The host could not be
   quietened without stopping other environments' work.
7. **Where to fix the vanishing tabs.** Options: stop resetting agent tabs
   when a container stops, special-case the seeding effect in
   `TerminalContainer`, or have `paneLayoutStore.reset` drop the hydration
   marker. We chose the store change. It is one line, keeps the reset that
   tears down dead terminal sessions, and makes a restart behave like a page
   reload, which already restores the persisted layout.
8. **The dev version banner.** It is unrelated to containers, so it was
   recorded as a low-scored follow-up rather than fixed here.
9. **The Connection Failed after a restart.** It was first filed as a High
   item with the spec left strict; pressing **Retry** in the spec would have
   hidden the failure. The Multi Review then traced it to the teardown intent
   that `reset` left pending, and `99263373` fixed it. The item is closed on
   that diagnosis and 4 of 4 passing runs, including a forced teardown sweep.
   It stays reopenable if the failure appears without a pending intent.

## Results, 2026-10-21 (C21 live: Codex rotation and account switching)

Commit `688f9f69` plus this change. Host: macOS 27.0, Apple M5 Pro, Docker
Desktop (Engine 29.8.2, `linux/arm64`), shared with other environments'
test runs (load average about 8). Image: the workspace's isolated development
image `orkestrator-v2:dev-4ec6b15ad812` (`8cd8f2f670ba` at `688f9f69`, then
`19c1be6fb5ac` with the fixes below; codex-cli 0.162.1, Grok 1.0.52). Profile
`cred-rot-0700`, started with `--fixture --fixture-environments
local,container --credential-source codex --credential-source grok
--agent-platforms codex,grok` and `CODEX_HOME` pointed at a disposable copy
of the host login with its refresh token blanked. Every "host" rotation below
rewrote that copy (or an added account's directory in the profile), never the
host's `~/.codex`. Turns went through `ensure_native_agent_session` and
`dispatch_native_agent_prompt`, the path the renderer uses, so the backend's
live-work guard saw them.

- Baseline: the container's `~/.codex/auth.json` had an empty refresh token,
  a fresh `last_refresh` and mode 600; a real turn answered.
- Host rotation during a turn: while a 1,200-number turn ran, the host login
  was rewritten (a `rotation-1` field added) and `start_codex_server` called
  again. The bridge was reused (same port and token), the container's login
  was untouched and the turn finished. This is the documented behaviour:
  Codex is re-read from the host only before a start.
- Restart: `stop_environment` and `start_environment` restaged the rotated
  login (refresh token blank, `last_refresh` reset, mode 600). The staged
  revision held no `.partial` or `.tmp` entries. The same session then
  recalled a codeword from before the restart.
- Container copy past expiry: the container's own access token was given an
  `exp` an hour in the past (claims otherwise real; the server rejects it) and
  the bridge restarted. Codex tried a refresh with the blank token; OpenAI
  answered 400 `empty_string`, and turns failed with "workspace routing
  discovery unauthorized (401)". Nothing on the host was read for this and
  nothing could be spent: the container holds no refresh token. A restart
  restaged the host login and the next turn answered.
- Host login expired: staging withheld it (the staged file was removed) and
  the container kept the copy it had, which in practice is the same expired
  token. After restoring the host copy, a restart signed the container in.
- Account switching under a running turn: with a second Codex account
  seeded into the profile (an access-only copy of the same login, tagged
  `account-b`), the active account was switched while a 1,500-number turn
  ran, and `start_codex_server` called during it. The busy bridge kept its
  login and the turn finished (all 1,500 numbers and `DONE`). Once idle, the
  backend pushed account B's login access-only, wrote the account marker and
  replaced the bridge; the same session recalled its codeword on account B.
  Rotating account B's own login and restarting restaged B's login, not the
  host's.
- Opt-in Grok live renewal spec (`grok-container-login.spec.ts`): skipped
  explicitly at 2026-10-21T07:58Z, because the host Grok access token expired
  at 2026-10-20T16:24:55Z (see the Grok qualification item in
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md)).
- `test:agent:docker` on the same profile and the rebuilt image: 9 passed,
  2 skipped (the opt-in live Claude C11 spec and the Grok spec above).
- Host `~/.codex/auth.json` and `~/.grok/auth.json`: SHA-256 prefix and
  mtime recorded before and after the run; both unchanged.

### Problems found and fixed

1. **A restart left a switched-back container on the added account.** With
   account B active, a restart restaged B's login, then the start path cleared
   the container's Codex account marker, and a missing marker reads as the
   host login. Switching back to the host then matched that marker, so
   nothing was pushed and turns kept running on account B until the next
   restart. Reproduced live. A first fix recorded the staged account in an
   in-process map for the start path to write, and was re-run live (the
   marker named B after the restart, and the switch back pushed the host
   login). Multi Review then found four ways that hint could still name the
   wrong login: the marker and the login came from two registry reads; a
   start of an already-running container restaged without importing; a lost
   hint cleared the marker; and a failure after `docker start` left the old
   marker. Now staging never names an account. A real start (the container
   was stopped) sets the Codex marker to `unstaged`, a value no account
   matches, right after `docker start` and before any later step can fail;
   the entrypoint does the same before it imports, so a backend that dies
   mid-start is covered too. The next idle bridge start then pushes the
   active login and writes its marker, taking the account, home and
   generation from one registry read. A start of a running container leaves
   the login and marker alone. The revised design has unit and registry
   fixture coverage but has not been re-run live.
2. **A lapsed Codex login read as "temporarily unavailable".** Codex 0.162.1
   answers `account/read` with an RPC error ("workspace routing discovery
   unauthorized (401)") rather than a signed-out account once its token is
   refused and cannot be refreshed. The bridge returned HTTP 500 for
   `/global/auth`, the backend reported "authentication status is temporarily
   unavailable", and the sign-out was never confirmed, so no sign-in prompt
   appeared. The engine now reads that refusal as the signed-out answer. Re-run
   live on the rebuilt image: auth status `needs-auth`, and the session
   projection carries `readiness: authentication-required` with "You've been
   signed out of Codex" and the "Codex sign-in expired" notice.

### Decisions

1. **How the start path records the installed Codex account.** Options: an
   in-process map from container to marker, filled by the restage and taken
   by the start (the first fix); a marker file inside the staged revision
   copied by the entrypoint; writing the current active account's marker at
   start; or never naming an account at start, invalidating the marker on a
   real start and letting the next idle bridge start reconcile. The map
   needed no image change, but review showed it can be lost, consumed by an
   overlapping start, or applied when nothing was imported. A file in the
   revision still trusts that the entrypoint ran and imported it, and the
   current account at start can name an account switched to after the
   restage. We chose invalidation: only a push the backend made itself
   writes a real marker. It costs one access-only Codex login push on the
   first bridge start after each real start, for users who have used
   accounts, and a one-line entrypoint change (the backend write covers
   older images). Going back to a hint means re-solving the four review
   findings.
2. **Codex sign-out detection.** Options: map only `account/read` errors that
   say `unauthorized (401)`, `HTTP 401` or `401 Unauthorized` to signed out;
   or treat every account read failure as signed out. Only the first keeps a
   transient failure from asking a working account to sign in. A future Codex
   that reports the refusal differently falls back to today's "unavailable".
3. **Scope.** Claude credential handling is being changed elsewhere in the
   same batch, so its rotation was left to run after that lands, and logged.

## Outstanding work

### Qualification

Done on 2026-10-23 (evidence in [Results, 2026-10-23](#results-2026-10-23)):
the Desktop residuals (full-network fixture and a root terminal), native arm64
evidence, the registry measurements, C13 for Codex, OpenCode, Cursor and Pi,
the stopped environment's pending interactions, readiness fault injection and
C10, a daemon disconnect mid-copy and a kill around the rebuild commit, the
upgrade and rollback with real releases, and the live host-service reply on
Desktop. What remains of those items:

- Rootless Engine on a real Linux host: ran 2026-10-25 on Omarchy (kernel
  7.2.8, x86_64) with Docker 29.9.1 rootless as a systemd user service
  (RootlessKit 3.3.0, slirp4netns) and `cpu memory pids` delegated
  ([evidence](../../development/container-qualification.md#rootless-linux-host-2026-10-25)).
  - Pass: volume storage, migration, rebuild, restore and the copy and
    commit fault paths (C12, C14–C19, C15 on a rerun, the data contracts);
    the firewall modules and policy 3 (C23); and the budget read-back (C24).
  - Fail: staged-input UID mapping (C20), host-service reachability (C22),
    read-only file binds from `nosuid`/`nodev` sources (two C09 fixtures)
    and ephemeral port collisions (one C15 run). These were the retired to-do 0109's work
    ([rootless re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09));
    what is left is in [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md)
    and [7549](7549-rootless-docker-cp-refusals.md).
  - A host that delegates `memory pids` without `cpu`: done 2026-11-10 (task
    2); Docker reports CPU unsupported there and the read-back stays
    truthful.
- C13 and the C21 live half for Grok, and the Claude half of C21 that a
  disposable Claude account would unlock: moved to the manual-test
  checklist (7568) on 2026-11-10 (they need a current host Grok login and a
  disposable Claude account).
- A daemon-wide Docker restart or Desktop quit during launch and during a
  rebuild copy. The shared daemon here could not be restarted. The proxy
  reproduces what the CLI sees, not daemon-side effects (containers stopped by
  the restart, `--rm` helpers killed mid-write). Run it on a dedicated host or
  VM.

## Assumptions and decisions

Made on 2026-10-23 during the qualification pass. Each gives the options
considered, the choice, why, and its pros and cons.

### Assumptions

- The host's Docker Desktop is shared with other environments, so it must not
  be restarted, pruned or reconfigured. Fault injection that would need that
  was modelled through fixtures, and the gap recorded.
- The `dev:test --credential-source` flags are the authorized way to use host
  provider logins. Nothing may spend or rotate a host refresh token; host
  credential files were checked by SHA-256 prefix and mtime before and after
  every provider run.
- A nested `docker:dind-rootless` shows the daemon's own behaviour (Moby's
  cgroup driver `none`, the rootless security option, firewall primitives in a
  user namespace) but not a Linux host's systemd delegation, kernel modules,
  networking or UID mapping.
- Results from runs the reboot interrupted were kept only where the finished
  agent's report recorded them in full; the C13, registry, upgrade/rollback and
  benchmark figures were all re-run after it.

### Decisions

1. **One qualification image for every run.** Options: per-suite images, a
   `docker/build.sh` tag, or the workspace's development image built once from
   `06297124`. Chose the development image: one id serves the live suites,
   benchmarks, real-stack profiles and the nested rootless run, and its
   manifest proves the source. Con: it carries the workspace's tag, not a
   release tag.
2. **Rootless: supported with gated features** (answers the open question).
   Options: refuse rootless outright; support it with each unenforceable
   feature refused precisely; claim full support. Chose gated support. The
   only enforcement a rootless daemon silently dropped was cgroup budgets,
   which are now refused before Docker sees them, and the firewall either
   works or fails closed. Pros: nothing is silently weakened; a setup the app
   itself recommends keeps working without a budget. Cons: host reachability,
   UID mapping and partial delegation are unproven, so a rootless user may hit
   typed failures the docs do not yet describe. Refusing outright would have
   discarded protection shown to work; full support is not justified.
3. **Unknown budget support.** Options: refuse whenever `docker info` did not
   answer, refuse only on a rootless daemon, or never. Chose rootless only
   (`daemon-unavailable`): there the read-back cannot reveal non-enforcement.
   Con: a rootful daemon with no answer still takes the budget on trust, as
   before.
4. **Stale pending interactions after a stop.** Options: drop them from the
   projection in a new announced revision when the stop commits; write a
   `withdrawn` state; invalidate the projection cache; filter at each reader;
   react to every environment change. Chose the first. Interaction snapshots
   carry only `pending` and `answering`, and the web tab renders every listed
   request, so a `withdrawn` entry would show a card; invalidation loses the
   transcript the coordinator reads; per-reader filters leave the projection
   wrong. Con: stops outside `stopEnvironmentOnce` are not covered (0061, item
   2), and the withdrawal is visible only as a disappearance.
5. **How to hold a boot before `ready`.** Options: SIGSTOP the entrypoint, or a
   derived image whose firewall wrapper waits once for a release file. Chose
   the derived image: SIGSTOP lost the race twice on this host. Con: those two
   tests do not run the real firewall step (the others do).
6. **DNS fault at boot.** Options: a `--dns` knob (there is none), a TEST-NET
   resolver (Docker Desktop answers it itself), or a pre-created `--internal`
   network the backend adopts by its labels. Chose the adopted network, plus a
   silent loopback resolver for the C23 re-run. Con: at boot it is "no outside
   DNS and no route", not DNS alone.
7. **C22 when the path is reported closed.** Options: skip, or fail with an
   explicit `INCOMPLETE:`. Chose failing: Bun cannot skip at run time and a
   skip would read as a pass. Con: a Linux host whose firewall blocks Docker
   traffic fails this test by design.
8. **Daemon disconnect.** Options: a PATH shim `docker`, a `DOCKER_HOST`
   unix-socket proxy, or a production setting (forbidden). Chose the proxy: the
   backend only uses the CLI, so the CLI's real error text is exercised, which
   is exactly what exposed problem 1. Con: it cannot model daemon-side effects
   of a real restart.
9. **Kill seam around the commit write.** Options: a gated hook in
   `container-replacement.ts`, pausing on `emit`, or wrapping
   `storage.updateEnvironment` in a child driver. Chose the wrapper: no
   production change, and it parks exactly at the durable write. Con: it
   recognises the commit write by content; the test asserts the durable record
   at the pause to prove the boundary.
10. **What counts as an absent source path.** Options: keep `no such file` and
    exclude connection errors, or accept only the daemon's own `Could not find
    the file`. Chose the strict rule: an unknown wording now fails the rebuild
    with the original kept, instead of silently skipping a path.
11. **Where the `/project-files` repair runs.** Options: keep it before
    readiness and map its failure, or move it after readiness. Chose after:
    only setup reads those files, and only once the boot is ready.
12. **Claude rotation source.** Options: rotate the host login (forbidden),
    point `CLAUDE_CONFIG_DIR` at a copy (no effect on macOS, where the Keychain
    is read first), or seed disposable added accounts with access-only copies.
    Chose the added accounts: the real switch, staging, keeper and start-sync
    paths run and no refresh token exists anywhere. Con: a "rotation" is a
    rewrite of the file, not Anthropic's refresh exchange, and both accounts
    are one identity.
13. **Cursor key change during a turn.** Options: refuse with a retryable
    error while busy, keep the busy bridge and apply the key when idle, or
    leave it. Chose keep-until-idle, matching Claude and Codex account
    switching. Con: a revoked old key stays in use until the turn ends. The
    local path still has the gap (0061, item 6).
14. **Cursor allowlist.** Added the exact host `api.cursor.com`; policy 3 has no
    wildcards, and a wildcard would be broader.
15. **Full-network fixture.** Options: a launcher flag, changing an existing
    environment's mode (impossible after creation), or having one spec create
    its own environment. Chose the opt-in `--fixture-network full`, so the
    whole Docker set runs unchanged on full network. Con: one more launcher
    flag to document.
16. **OpenCode egress for C13.** Options: add `opencode.ai` to OpenCode's
    required hosts, or allow it on the qualification environment only. Chose
    the environment only: the product default widens egress for every OpenCode
    install and is a product decision (0061, item 9).
17. **Ambiguous dispatch injection.** Options: pause the bridge or provider
    process, or drop only prompt requests to the bridge from inside the
    environment's container. Pausing either rejected or accepted the prompt;
    dropping made the outcome genuinely unknown. Con: only Codex, Cursor and Pi
    ran it; OpenCode and Claude did not.
18. **Cold pull without touching the user's cache.** Options: remove the local
    image first (forbidden), time a blob transfer through the registry API, or
    pull into a throwaway labelled `docker:dind`. Did both of the last two:
    the transfer gives the network-only figure, the dind gives download plus
    extraction. Con: the dind adds a privileged container and its own storage
    overhead.
19. **Upgrade starting point.** Options: build a pre-floor commit plus a
    manifest-less image, or start from the oldest published release. Chose
    v2.21.0, which is also the floor: a self-built "release" would not be a
    real one. Con: records without lifecycle data and unlabelled containers
    were never upgraded live.
20. **Read-only mode test.** No release writes a marker requiring writer 2, so
    the harness plants one, labelled as synthetic, on both the floor and the
    current backend. It is the only way to exercise read-only mode with real
    binaries today.
21. **Fixing the read-only gap.** Options: gate each command, or route delete
    and the allowlist apply through the lifecycle service. Chose a direct
    `registryWriterLease.assertHeld()` in the delete path for container
    environments and before the allowlist `docker exec`, matching how the
    lifecycle service gates itself. The saved allowlist still stands and is
    reported as not enforced. The host-service port refresh
    (`ensureContainerHostServicePorts`) was left ungated: it keeps a running
    container able to reach this backend's agent tools and changes no user
    setting. Con: the fix reaches only releases that contain it; v2.21.0, the
    floor today, keeps the gap.
22. **Published minimum versions** (answers the open question). Options:
    publish the code's own floor (Engine 26, below which volume sub-path mounts
    and persistent storage are unavailable), publish only qualified versions,
    or publish none. Chose to state the qualified versions (Engine 29.7.2 on
    Linux, Desktop 4.93–4.95 with Engine 29.8.x) as the supported minimum, with
    Engine 26 to 29.6 "expected to work, not qualified" and older engines on
    legacy storage only. Pros: the claim matches the evidence. Con: users on an
    older Engine are told "not qualified" rather than refused.
23. **Scheduled CI job** (answers the open question). Options: none, a manual
    workflow, or a scheduled one. Chose weekly plus on demand plus pull
    requests that touch the suites, on `ubuntu-24.04` and `ubuntu-24.04-arm`,
    with a unit test that fails if a live suite is missing. Pros: Linux Engine
    evidence on both architectures without a dedicated host. Cons: CI minutes
    (a full image build per architecture), and a rootless job is not included:
    setting rootless up on a hosted runner could not be tried locally.
24. **Benchmarks.** Re-run after the reboot rather than waiting for an idle
    host; load was 18 at the start and every target was met. Con: still not an
    idle-host reference.
25. **New work goes to a new file.** Gaps found but not fixed went into
    0061 (retired 2026-11-10), since an existing todo
    file never takes new items. Two flake recurrences were added to their
    existing cases (0506, 0518).

### 2026-11-06, task 6: fix the scoped Docker shim by exec, not signal forwarding

The shim kept its pass-through child alive after a SIGTERM. Options: forward
signals from the bun shim to its child; or `exec` the real CLI from the shell
wrapper for everything except `network create` (chosen). Exec makes the shim
the Docker process itself, so SIGTERM, SIGKILL, SIGWINCH for `exec -it` and
exit status all reach Docker unchanged. Signal forwarding cannot cover
SIGKILL of the shim, and it adds a bun process per Docker call. Con: the
wrapper resolves the real CLI in POSIX shell, a second copy of the
TypeScript lookup (`ORKESTRATOR_QUALIFICATION_DOCKER`, else the first `docker`
on PATH outside the shim directory). `network create` still goes through
bun, because that is where the /29 fallback lives and the call is short-lived.

### 2026-11-06, task 6: parent-bind the container log follower

`ContainerLogService` now spawns followers with `spawnParentBoundCommand`.
The alternatives were to leave it, since a follower dies on its next write
after the backend is gone, or to sweep orphans at backend start. Leaving it
fails on a quiet container, which is the usual state once setup has
finished: the live run had one still alive after 64 s. A start-up sweep would
need to identify another process's followers by command line, which is the
kind of process-scan signalling this repository forbids. Parent-binding is the
mechanism the OOM watcher already uses (#1301). Con: two extra shell processes
per followed container, at most 16 followers per backend.

### 2026-11-06, task 6: add a SIGKILL step to the qualification

The to-do's steps cover only the graceful `dev:stop` path. The run also
SIGKILLed the profile's own backend (PID and start time read from
`dev:status` and checked against `/proc` first), because that is how a
backend actually disappears on this host (AGENTS.md: the production backend
has been SIGKILLed during test runs). It found defect 2 above. It affected
only the isolated profile.

### 2026-11-06, task 7: restart over a live container, three times

Each restart ran the same `dev:test` command. The run did not stop the fixture
container between restarts, because a backend stop leaves containers running
by design and the to-do asks whether a restart reuses that container. Reuse
after a SIGKILLed backend was checked as well, since the fixture code cannot
tell the two cases apart.

### 2026-11-06, task 2: wait for 4730 (superseded 2026-11-10)

Task 2 stayed open for 4730's disposable rootless daemon, which another
build was creating; it has since merged and task 2 ran on it on 2026-11-10. Hand-building a third private daemon on beelink
would repeat work 4730 replaces, and 4730's launcher is what later runs will
use.

### 2026-11-10, task 2: a systemd container as the host, not omarchy-hp

Task 2 needs a user manager that delegates `memory pids` without `cpu`.
beelink's `user@1000.service` delegates `cpu memory pids`, and so does the
launcher's rootless daemon there, because its systemd cgroup driver creates
each container's scope in the user's own manager. Options:

- **A drop-in on the daemon's own user service (the recommended option
  above).** Pros: no new machine. Cons: container scopes are created in the
  manager's `user.slice`, outside that service, so the drop-in would not
  narrow what they get. Not used.
- **Narrow the host's `user@.service`.** Pros: the real topology. Cons: needs
  root and a restart of the user manager, which ends every session of this
  user on a shared host, the production Orkestrator backend included. Not
  used.
- **A privileged systemd container as the host, with the drop-in on its own
  `user@.service`, running the same launcher (chosen).** Pros: a real systemd
  user manager on the same kernel, delegating through cgroup v2 exactly as a
  host would; the daemon is `docker:disposable`'s rootless daemon unchanged;
  everything is disposable. Cons: one more layer (a private cgroup
  namespace inside a container), and it is still one kernel.

`Delegate=` lists merge, so the drop-in has to reset the list (`Delegate=`)
before `Delegate=memory pids`; without the reset Debian's own `cpu` stayed
delegated. The daemon's data root has to be on a tmpfs, because overlayfs
refuses an upper directory on the container's own overlay root.

### 2026-11-10, task 2: commit the evidence script

The comparison of Docker's report with the cgroup files and the kernel's
behaviour is `apps/backend/scripts/rootless-budget-readback-evidence.ts`,
committed so the run can be repeated (the 2026-11-04 loopback fixture that
lived only in a git-ignored folder is the reason, 4730 task 2). It calls the
production capacity, default, refusal, argument and read-back functions and
removes its labelled containers by id. A hand-run `docker run` sequence was
the alternative; it would not have exercised the backend's own read-back.

### 2026-11-10, task 2: no code change

Docker's report matched what the cgroup enforced, the read-back reported
what was applied, and an unenforceable CPU limit cannot reach a container on
such a daemon, so nothing in `container-resources.ts` changes. Not covered: a
host whose `user-<uid>.slice` exposes a controller its `user@<uid>.service`
does not. Here both had `memory pids`, so the run cannot tell which of the
two Docker reads.

### 2026-11-06: no new to-dos

Both defects were fixed in this change, so numbers 7410–7419 are unused. The
shim's orphans on other worktrees' runs stop once those branches carry the
fixed shim. None were left under systemd at the end of this run, and none
were removed.

## Constraints and rationale

- Never test against a production installation or the packaged user's Docker
  resources, and never use or retag `orkestrator-v2:latest` as the
  qualification image.
- Label every resource with a private owner namespace and remove exactly
  those. Never prune, globally or by owner.
- A skipped or timed-out run is incomplete, not a pass. Record flakes in the
  registry; do not weaken assertions to hide races.
- Provider runs use only authorized agent-test credential sources. Synthetic
  file, network and lifecycle scenarios need no real credentials.
- Never claim one provider's capability from another's success. An untested
  capability stays "pending qualification" in the product.
- A fake `docker` executable cannot prove filesystem retention, packet rules,
  mount permissions, name conflicts or signal delivery; those need the live
  suites.
- Benchmark artifacts carry no commands, paths, contents or private
  endpoints.

## Open questions

- Which Engine and Desktop versions become the published minimum, and is
  rootless supported with gated features or refused? Answered 2026-10-23:
  the qualified versions are the supported minimum, and rootless is
  supported with gated features (decisions 2 and 22).
- Should the live suites get a scheduled CI job on a Docker-capable runner
  (Linux amd64 and arm64)? Answered 2026-10-23: yes,
  `container-live-qualification.yml` (decision 23). Its first results arrive
  on the pull request for this change; record them in this file then,
  including the C22 host-level reachability verdict, which macOS reports as
  not applicable.

## Needs verification

- Whether anyone has run the live suites since #877. Answered: the
  replacement suite ran on 2026-10-16 (provider-state review) and the full set
  on 2026-10-17 and 2026-10-23.

## Related

- To-do 0061 (retired 2026-11-10): gaps the 2026-10-23 pass found and did
  not fix, now fixed; their behaviour is in
  [container lifecycle](../../architecture/container-lifecycle.md).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  shared prerequisites and batching. The Docker Desktop rows of
  [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) and
  [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md) belong in the same platform
  run.
- To-do 0035 (retired 2026-11-10; see
  [narrow-layout.md](../../architecture/narrow-layout.md#settings-from-the-projects-drawer)):
  the environment settings dialog blocked by the projects drawer, found during
  the container settings real-stack run.
- [7548-rootless-gvisor-tap-vsock-host-loopback.md](7548-rootless-gvisor-tap-vsock-host-loopback.md)
  and [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md)
  (what the rootless runs left, after the retired to-do 0109),
  [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md),
  [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md),
  [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (container deletion through the ledger on Desktop).
- [Container qualification](../../development/container-qualification.md):
  C01–C30 scenario definitions, platform dimensions, suite commands and
  benchmark targets.
- [Container lifecycle](../../architecture/container-lifecycle.md),
  [agent testing](../../development/agent-testing.md),
  [testing guide](../../development/testing-guide.md).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 3 and 4) moved there on 2026-11-10.

## Replaces

- `docs/improvements/containers/qualification.md` (reproduce commands, open
  limitations; the per-scenario evidence is historical)
- `docs/improvements/containers/remaining-work.md` (environment-limited list;
  items 1–39 shipped in #877)
- `docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md`
  (release gates and the upgrade/rollback check; the scenario matrix, platform
  dimensions and evidence workflow moved to
  `docs/development/container-qualification.md`)
- `docs/improvements/containers/plan/00-index.md` (the minimum Engine/Desktop
  and rootless decision gate)
- `docs/improvements/containers/plan/01-immediate-data-loss-safeguards.md`,
  `docs/improvements/containers/plan/02-lifecycle-authority-and-durable-operations.md`,
  `docs/improvements/containers/plan/03-image-contracts-and-daemon-preflight.md`,
  `docs/improvements/containers/plan/04-runtime-readiness-and-graceful-shutdown.md`
  (limitation lines; the steps shipped in #877)
- `docs/improvements/containers/plan/05-persistent-workspace-and-agent-state.md`
  (per-provider resume limitation)
- `docs/improvements/containers/plan/06-migration-and-transactional-replacement.md`
  (live disconnect and kill limitation)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (live rotation)
- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (Desktop and arm64 packet tests, the ufw limitation)
- `docs/improvements/containers/plan/10-resource-budgets-and-usage-telemetry.md`
  (Desktop and rootless enforcement)
- `docs/improvements/containers/plan/12-image-build-and-release-delivery.md`
  (arm64, registry size and pull time)
- `docs/improvements/containers.md` (acceptance criteria for findings 5 and 9
  on Docker Desktop)
