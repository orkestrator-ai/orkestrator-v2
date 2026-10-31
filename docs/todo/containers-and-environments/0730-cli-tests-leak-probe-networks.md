# A backend stopped soon after boot leaks its host-reachability probe network, and the CLI tests do this on every run

Checked against `main` at `863b5782` (2026-10-27).

Every backend that does not run under `NODE_ENV=test` starts a background
host-reachability check at boot, which creates a probe network and removes it
only when the check finishes. The SIGTERM drain neither waits for nor cancels
that check, so a backend stopped within seconds of `ready` exits with the
network still there. The CLI package's test that starts a backend under
`NODE_ENV=development`, and every `test:cli:scenarios` scenario, do exactly
that under a new temporary data directory, so each leaked network belongs to an
owner nothing will ever see again. Over time they fill the daemon's address
pools and every new environment network on that host fails. Found in
[0241](0241-leaked-reach-probe-networks.md)'s task analysis.

**How this differs from 0241.** 0241 tracks the leak in general: finding the
source, owner-label cleanup in the leaking suite, the owner reaper, an
owner-agnostic sweep of the backlog, and the qualification that a full run
leaves nothing. This file owns the concrete defects the analysis found: the
graceful-shutdown path that leaks even without a kill (0241 assumed a kill),
the two CLI harnesses that start probing backends, and the reaper comment that
claims network removal. When it is done, 0241's code items 1 and 2 can be
ticked with a reference here; its reaper, sweep and qualification items stay
in 0241 unless task 4 below takes the reaper.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`. Re-checked 2026-10-31
against `main` at `931e5541`: the switch (`index.ts:2304`, both harnesses),
`dispose()` from `Backend.shutdown()` (`index.ts:2504`) and the network reaper
(`container-host-reachability.ts` `reapStaleProbes`) are all in place. Line
numbers cited below are from the original analysis.

### Tasks

1. **Confirm the two sources**: run each harness once and diff the probe-network list by label. Status: done (2026-10-31, beelink, Linux, Docker Engine 29.9.2): both harnesses leave nothing, and a probing backend stopped by SIGTERM leaves nothing either; see Assumptions and decisions.
2. **Settle the boot probe on shutdown**: a SIGTERM'd backend removes its probe network before it exits, within a bound. Status: done (2026-10-28).
3. **Keep harness backends from probing**: the CLI test and scenario backends start without the boot check. Status: done (2026-10-28).
4. **Make `reapStaleProbes` match its comment**: remove its owner's unattached probe networks, or say it does not. Status: done (2026-10-28); ticks 0241 task 3.
5. **Regression test and live check**: a unit test for the shutdown path and a before/after network count. Status: done. Unit tests 2026-10-28; live check of `dispose()` and the reaper on Docker Desktop 2026-10-28 and on Linux Engine 2026-10-31.

### 1. Confirm the two sources

**Problem.** The sources are identified from code. Nothing has tied a leaked network to a harness run.

**Context.** The service is built only when `NODE_ENV` is not `test` (`apps/backend/src/core/index.ts:394-400`), with owner `dockerOwnerNamespace(options.dataDir)`. The boot check is `void this.containerHostReachability?.check("boot")` (`:1932`).

**Investigation.**
- `packages/cli/tests/cli.test.ts:289-295` starts the packaged backend with `NODE_ENV: "development"` and a `mkdtemp` data directory (`:97-120`), and sends SIGTERM as soon as the ready line arrives (`stopPackagedBackend`, `:87-95`). The sibling test at `:283-287` inherits `NODE_ENV=test` from `bun test` and does not probe. The file runs in `mise run test` through the CLI package's `test:workspace` script.
- `test:cli:scenarios` runs `bun packages/cli/scripts/run-scenarios.ts` (`mise.toml:237-241`), not `bun test`, so `NODE_ENV` is unset. The launcher sets `production` (`packages/cli/bin/orkestrator.js:23`), and the harness passes the host environment through (`packages/cli/scenarios/provider-homes.ts:245-253`). Each scenario starts one backend on `<scenario root>/data` (`packages/cli/scenarios/harness.ts:134-199`, `packages/cli/scripts/run-scenarios.ts:130-134`) and stops it with SIGTERM, escalating to SIGKILL after 20 s (`harness.ts:248-257`).
- Host state now: `docker network ls` on omarchy-hp at 2026-10-27 12:06 UTC shows no probe networks and three networks in total. The 29 that 0241's analysis counted earlier the same day have been removed by someone; the pools are free today, but nothing stops them filling again.
- Certainty: likely. The path is clear in code; that each run leaks depends on the check still running at exit, which depends on Docker's speed and the image pull.

**Decisions.**

- **How to confirm?**
  - **Record the label list, run `cli.test.ts` alone and one scenario, list again, and remove anything new by its exact name (recommended).**
    - Pros: decisive per harness; cheap.
    - Cons: needs Docker; it creates the networks it is looking for, which must be removed afterwards.
  - **Accept the code reading and go straight to the fix.**
    - Pros: no Docker run.
    - Cons: a third source would go unnoticed until the qualification in task 5.

### 2. Settle the boot probe on shutdown

**Problem.** A graceful stop leaks, not only a kill.

**Context.** `createBackendShutdownHandler` (`apps/backend/src/shutdown.ts:24-70`) stops the gateway and the backend and then calls `exit`, which ends the process (`apps/backend/src/main.ts:242-261`). AGENTS.md: an aborted signal's every consumer must handle the rejection.

**Investigation.**
- The check holds its own promise in `inFlight` (`apps/backend/src/core/container-host-reachability.ts:468`, `:520-541`), so it can be awaited.
- The probe network is created at `:1067-1084` and removed only in the `finally` at `:800-808`.
- `Backend.shutdown()` (`apps/backend/src/core/index.ts:2104`) does not mention the service. Exiting skips the pending `finally`.
- Certainty: high for the missing step; whether a given stop leaks depends on timing.

**Decisions.**

- **How should shutdown treat a running check?**
  - **Give the service a `dispose()` that marks it closed, waits for `inFlight` up to a short bound (a few seconds), and on timeout removes its own `ork-<owner>-reach-probe-net` by name; call it from `Backend.shutdown()` (recommended).**
    - Pros: covers every graceful stop, harness or not; the removal is owner-scoped, so it is safe on a shared daemon; bounded.
    - Cons: shutdown can take a few seconds longer when a check is running; a SIGKILL still leaks.
  - **Thread an `AbortSignal` through the probes and cancel them on shutdown.**
    - Pros: faster stop.
    - Cons: every probe step needs a rejection handler, and a cancelled `docker run` can leave the probe container too, so it still needs the removal step.

### 3. Keep harness backends from probing

**Problem.** Neither harness needs the check, and each run makes a new owner that no reaper ever revisits.

**Context.** `NODE_ENV=development` in `cli.test.ts` exists to test bridge-path resolution outside `production`. Setting `NODE_ENV=test` is not an option: it also changes change-tracking durability, storage snapshots and other services (`apps/backend/src/core/change-tracking/backend-wiring.ts:50-51`, `apps/backend/src/core/storage-context.ts:66`).

**Investigation.** Neither harness touches Docker networks. The scenario runner already has a per-scenario cleanup list that always runs (`run-scenarios.ts:162-171`).

**Decisions.**

- **How do harness backends avoid the check?**
  - **An internal environment switch (for example `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`) read next to the `NODE_ENV` test, set by both harnesses (recommended).**
    - Pros: no public service flag; changes nothing else in the backend; the harnesses stay on `production` or `development` as they test.
    - Cons: one more environment variable to document; a scenario that wants the check must not set it.
  - **A public service flag registered in `apps/backend/src/server-flags.ts`.**
    - Pros: explicit, visible in `--help`.
    - Cons: public CLI surface for a test need; client and launcher parsing must learn it.
  - **Leave the check on and remove networks by owner label in each harness's teardown.**
    - Pros: no backend change.
    - Cons: the harnesses would need the backend's owner derivation; a SIGKILL escalation or watchdog kill skips teardown.

### 4. Make `reapStaleProbes` match its comment

**Problem.** The comment says "Removes probe containers and networks an interrupted check left behind" (`container-host-reachability.ts:1133`). The method lists and removes only containers (`:1134-1159`).

**Context.** This is 0241's code item 3. `createProbeNetwork` already removes a same-owner leftover before creating (`:1069-1070`), so a stable owner leaks at most one network.

**Investigation.** Confirmed by reading the method.

**Decisions.**

- **Fix the code or the comment?**
  - **Extend the reaper to unattached probe networks of its own owner, in the same change as task 2, and tick 0241's item 3 (recommended).**
    - Pros: the same file and owner-scoped removal as task 2's fallback; the comment becomes true.
    - Cons: one more `docker network ls` per check; does not help one-off owners (tasks 2 and 3 do).
  - **Reword the comment to "containers" and leave networks to 0241.**
    - Pros: smallest change.
    - Cons: leaves a known gap open in a file this change already edits.

### 5. Regression test and live check

**Problem.** Nothing would catch a return of the leak.

**Context.** The service takes an injected `run`, so its Docker calls can be faked.

**Investigation.** No test covers shutdown during a check.

**Decisions.**

- **What proves it?**
  - **A unit test that starts a check whose probe never settles, disposes the service, and expects `docker network rm ork-<owner>-reach-probe-net` within the bound; plus a live before/after count around one `cli.test.ts` run and one scenario (recommended).**
    - Pros: deterministic for the code path; the live half proves the harnesses.
    - Cons: the live half needs Docker on the host.
  - **Live count only.**
    - Pros: real evidence.
    - Cons: timing-dependent; a pass can be luck.

## Assumptions and decisions

Made 2026-10-28 while implementing this file together with
[0241](0241-leaked-reach-probe-networks.md).

### Task 1: confirming the sources

- **Chose (2026-10-28):** not done here; deferred to a Linux host.
- **Why:** the work ran on macOS, where `runCheck` returns `not-linux` before
  any Docker call. A harness run here cannot create a probe network, so a
  before/after diff would be empty whatever the code does. `cli.test.ts` ran
  here with the count at 0 before and after; that is not evidence.

### Task 1: Linux qualification (2026-10-31)

- **Chose:** the recommended before/after diff, plus controls with the boot
  check forced on. With the switch off, a clean diff only proves that the
  switch works. The controls show that the shutdown fix holds when a backend
  does probe, and that the measure would catch a leak.
- **Host:** beelink, Arch Linux, rootful Docker Engine 29.9.2, `main` at
  `931e5541`, the CLI built with `mise run build:cli`. The daemon had no probe
  networks at the start (02:18 UTC), and other workers were using it. A
  `docker events` recorder logged every network create and destroy and every
  probe-role container event for the whole run.
- **Harnesses, as shipped (switch off):**
  - `bun test --cwd packages/cli --preload ../../tests/setup-node.ts
    tests/cli.test.ts --parallel=1`: 8 passed, and the label list was
    0 before and 0 after.
  - `mise run test:cli:scenarios`: all 9 scenarios passed, and the list was
    0 before and 0 after. None of the 9 scenario owners (`sha256` of each
    `/tmp/ork-cli-*/data`) created a probe network. One probe network
    appeared during the run (`ork-33594a4bfd1a31f1-…`, 02:20:38–44). Its
    owner matches no scenario data directory, it was another process on the
    daemon, and it removed itself within 6 s.
- **Controls, switch on** (a throwaway script ran the packaged launcher with
  `NODE_ENV=development` on a fresh temporary data directory, under a
  temporary `HOME`):
  - SIGTERM straight after `ready`, 3 runs: the signal landed before network
    creation, shutdown took 0.27–0.67 s, and nothing was left.
  - SIGTERM as soon as the probe network existed, 3 runs: nothing was left.
    Twice the closed guard and the check's own `finally` removed the network
    within about 0.3 s. Once both probe containers were running, so
    `dispose()` waited its 3 s and logged `shutdown removing probe resources
    … containers=2`. It killed both containers and then removed the network,
    and the backend exited 3.9 s after the signal.
  - SIGKILL as soon as the probe network existed: the network leaked, while
    the two probe containers (`--rm`) went away by themselves. This is the
    sensitivity control: a leak does show up in the measure.
  - Restarting that same data directory: the boot check logged `removing 1
    stale probe network(s)` (the owner reaper from 0241 task 3), then ran and
    removed its own network. The list went back to 0.
- **Answers "Needs verification":** on this host, with the probe image
  already present, the check reaches network creation about 0.5–1 s after
  `ready`. Without the switch and the shutdown fix, a backend stopped in
  the following ~5 s would have leaked on most runs, not only when the image
  had to be pulled.
- **Cleanup:** this run created only the networks of its own control owners.
  Each one was removed by its own backend or by the reaper, and the label
  list ended at 0. Nothing that existed before the run was touched.

### Task 2: settling the probe on shutdown

- **Chose:** the recommended bounded `dispose()`, called from
  `Backend.shutdown()`.
- **How it works:** `dispose(waitMs = 3_000)` marks the service closed, so
  `check()` returns the current snapshot without running and a check still
  preparing creates no network. It waits up to `waitMs` for the running
  check's own `finally`. It then removes whatever is still tracked: the probe
  containers whose `docker run` has not returned (`docker rm -f`) and then
  `ork-<owner>-reach-probe-net`, each command bounded at 5 s. Worst case is
  about 13 s, under the desktop supervisor's 20 s SIGKILL and the scenario
  harness's 20 s escalation. It never rejects.
- **Where shutdown calls it:** first thing in `Backend.shutdown()`, so the
  wait overlaps the rest of the drain. It is awaited in the `finally` after
  the agent tools server stops; that also makes a still-running probe fail
  fast.
- **Why the service tracks names:** probe container names are random, so
  removing them without a `docker ps` listing at shutdown means tracking
  them.
- **Live (Docker Desktop, `platform: "linux"` injected, owners generated by
  the run):** `dispose(0)` straight after the network appeared removed it in
  489 ms. The check then finished with no network and no container of that
  owner left.

### Task 3: keeping harness backends from probing

- **Chose:** the recommended internal switch,
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`.
- **Scope:** it skips only the boot check (`index.ts`, next to the `void
  check("boot")` call). It does not skip building the service.
- **Why not skip building the service:** container scenarios still get the
  on-demand checks (rootless container creation, workflow preflight), as
  under `production`, and `dispose()` now settles those.
- **Where it is set:**
  - `cli.test.ts` sets it before its overrides, so the `NODE_ENV=development`
    test keeps testing bridge-path resolution.
  - `prepareIsolatedBackendEnvironment` sets it for every scenario backend. A
    host value cannot turn it back on; only a scenario's own `env` can.
- **Docs:** `docs/development/testing-guide.md` (CLI scenarios).

### Task 4: the reaper

- **Chose:** the recommended option, the same change as 0241 task 3. See
  0241's Assumptions and decisions.

### Task 5: tests

- **Unit tests** (`container-host-reachability.test.ts`):
  - shutdown during a hung check removes the probe containers, then the
    network, within the bound;
  - a check that finishes in time cleans up itself, with no extra removal;
  - a check still preparing creates no network after shutdown;
  - shutdown with no check running touches no Docker;
  - the reaper removes only this owner's names, one per call.
- **Backend wiring** (`index-host-reachability-boot.test.ts`): the boot check
  runs, or is skipped under the switch, and shutdown calls `dispose()`.
- **Scenario environment** (`scenario-provider-homes.test.ts`): asserts the
  switch.
- **Live check:** a throwaway script drove the real service against Docker
  Desktop, removing only its own owners' resources by exact owner label.

### Residual

- In the live check, the probe containers were created by `docker run` just
  *after* shutdown's `docker rm -f`, which therefore found nothing yet. They
  hold no address pool (the network was already gone), the bridge one is
  `--rm`, and here the check's own error path removed the other.
- In a process that exits at once, a probe container whose start failed
  because its network was gone may stay `Created` under a one-off owner. It
  holds no network.
- Linux (2026-10-31): not seen. In every SIGTERM control the probe
  containers were removed before the process exited. After the SIGKILL
  control only the network was left, and the containers' `--rm` removed
  them.

## Current state

Before the 2026-10-28 change (see Tasks for what is done):

- The boot check runs in every backend outside `NODE_ENV=test`
  (`index.ts:394-400`, `:1932`), creates `ork-<owner>-reach-probe-net`, and
  removes it only in the check's `finally` (`container-host-reachability.ts:800-808`).
- Shutdown does not wait for or cancel the check (`shutdown.ts`,
  `index.ts:2104`).
- `cli.test.ts:289-295` and every `test:cli:scenarios` scenario start such a
  backend on a temporary data directory and SIGTERM it.
- `reapStaleProbes` removes containers only, despite its comment.
- omarchy-hp has no probe networks at 2026-10-27 12:06 UTC; 0241 recorded 29
  earlier the same day.

## Outstanding work

### Code

Items 1 to 4 are done (2026-10-28).

1. Add a bounded `dispose()` to `ContainerHostReachabilityService` that waits
   for an in-flight check and otherwise removes its own probe network, and
   call it from `Backend.shutdown()`.
2. Add an internal switch that skips the boot check, and set it in
   `packages/cli/tests/cli.test.ts` and `packages/cli/scenarios/harness.ts`.
3. Make `reapStaleProbes` also remove its owner's unattached probe networks
   (0241 code item 3), keeping the comment true.
4. Unit test: shutdown during a check removes the network within the bound.

### Qualification

Done 2026-10-31 on beelink (see Assumptions and decisions, task 1).

- On a Linux host with Docker: record
  `docker network ls --filter label=orkestrator-resource-role=host-reachability-probe`,
  run `mise run build:cli`, then
  `bun test --cwd packages/cli --preload ../../tests/setup-node.ts tests/cli.test.ts --parallel=1`
  and `mise run test:cli:scenarios`, and confirm the list is unchanged.

## Constraints and rationale

- Remove only networks this owner created, by exact name or owner label.
  Never remove other owners' networks on a shared daemon (0241).
- Shutdown stays bounded: a Docker that hangs must not stop the backend from
  exiting.
- Never kill or signal a backend by name or port when testing this; use the
  handle the harness spawned.

## Open questions

- None.

## Needs verification

- Answered 2026-10-31 (task 1): with the image present, the check creates
  its network within about a second of `ready`, so before the fix most quick
  stops would have leaked, not only those that pulled the image.

## Related

- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md) (the source; the general leak, the sweep and the qualification)
- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md) (test leaks)
- [CLI testing](../../development/cli-testing.md)

## Replaces

Nothing; new on 2026-10-27, split from
[0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md)'s
task analysis.
