# Leaked host-reachability probe networks exhaust Docker address pools

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Find the leaking run**: identify which test or harness boots a real backend whose boot probe is killed mid-check. Status: done in code (2026-10-28, [0730](0730-cli-tests-leak-probe-networks.md)): `cli.test.ts`'s development backend and every `test:cli:scenarios` backend, leaking on a graceful SIGTERM, not only a kill. Live attribution by owner needs a Linux host (see Assumptions and decisions).
2. **Suite-level cleanup by owner label**: the leaking suite removes its probe networks in `afterAll`. Status: done another way (2026-10-28): both harnesses skip the boot check and a SIGTERM'd backend now removes its own probe network ([0730](0730-cli-tests-leak-probe-networks.md) tasks 2 and 3). No `afterAll` backstop was added; see Assumptions and decisions.
3. **Owner reaper also removes networks**: `reapStaleProbes` removes the owner's unattached probe networks, not only containers. Status: done (2026-10-28).
4. **Qualification: no new probe networks after a full run**: a full `mise run test` plus the live Docker suites leaves nothing new. Status: open; needs a Linux host (the check never probes on macOS).
5. **Owner-agnostic sweep (open question)**: whether a sweep should offer to remove old unattached probe networks whatever their owner. Status: open.

### 1. Find the leaking run

**Problem.** Something on the host boots real backends under one-off data directories and kills them while the boot reachability check is running. Each one leaves an `ork-<owner>-reach-probe-net` network behind, and once the daemon's address pools fill, no environment network can be created on that daemon.

**Context.** The boot check is `void this.containerHostReachability?.check("boot")` at `apps/backend/src/core/index.ts:1932`. The service is only built when `NODE_ENV` is not `test` (`apps/backend/src/core/index.ts:394-400`), and its owner is `dockerOwnerNamespace(options.dataDir)`, so every temporary data directory is a new owner.

**Investigation.** The file's description still holds. The probe network is created at `container-host-reachability.ts:1067-1084` and removed only in the `finally` at `:800-808`. The backend's SIGTERM drain (`apps/backend/src/main.ts:242`, `:260`) neither awaits nor cancels the in-flight check, so a backend stopped a few seconds after `ready` (a busybox pull plus two probes can take that long) exits before the `finally` runs.

On the host today there are 29 probe networks again, all with no containers. The daemon has 32 networks in total, so the pools are as full as they were when the file was written. Their creation times are: 21 on 2026-09-28 between 15:37 and 21:47 BST (the day the service landed, `7611e8f0`, #885), four at 00:51:56–00:52:06 UTC and three at 00:58:00–08 UTC on 2026-10-26, and one at 09:11 UTC that day. Within each cluster the networks are 3–5 s apart, which fits one harness starting backends one after another, not several concurrent suites.

These sources start a real backend with `NODE_ENV` not `test`:
- `packages/cli/tests/cli.test.ts:289-295` ("starts when the caller's environment already sets NODE_ENV") starts the packaged backend with `NODE_ENV=development` and a `mkdtemp` data directory, then sends SIGTERM straight after `ready` (`:87-95`). It is part of the CLI workspace tests, so a plain `mise run test` runs it. That is one network per run.
- `packages/cli/scenarios/harness.ts:172-199` (`test:cli:scenarios`) runs under plain `bun`, not `bun test`, so `NODE_ENV` is unset. The shim then sets `production` (`packages/cli/bin/orkestrator.js:23`), and each scenario starts and stops its own backend on a temporary data directory. This is the likeliest source of the 3–5 s clusters.

Inside `bun test`, the children of `apps/backend/tests/standalone.test.ts` inherit `NODE_ENV=test`, so they do not probe.

**Decisions.**

- **How to confirm the source?**
  - **Correlate owners with data directories (recommended).** Log the owner namespace each harness's `dockerOwnerNamespace(dataDir)` produces, run `test:cli:scenarios` and the CLI package tests once, and diff the probe-network list before and after.
    - Pros: cheap and decisive; identifies each harness by name.
    - Cons: needs Docker on the host; it adds probe networks, which must be removed afterwards by their exact owner labels.
  - **Reason from code only.**
    - Pros: no Docker run needed.
    - Cons: the 2026-10-26 clusters are not fully explained (the 00:58 cluster was attributed to a plain `mise run test`), so a second source could go unnoticed.

### 2. Suite-level cleanup by owner label

**Problem.** A harness that starts one-off backends never removes what their boot probes leave behind.

**Context.** The live Docker suites already remove labelled resources one per call through `removeLabelledResources` (`apps/backend/tests/container-live-cleanup.ts:34-52`).

**Investigation.** None of the candidate harnesses (`packages/cli/tests/cli.test.ts`, `packages/cli/scenarios/harness.ts`) touch Docker networks. Nothing in `apps/backend/tests` or `tests/` names `HOST_REACHABILITY_PROBE_ROLE` (`container-host-reachability.ts:52`).

**Decisions.**

- **Clean up after the probe, or stop it running in harnesses?**
  - **Disable the boot probe for harness backends, and clean up as a backstop (recommended).** Have the scenario and CLI harnesses start backends with the probe off (an explicit service flag registered in `apps/backend/src/server-flags.ts`, or `NODE_ENV=test` where that changes nothing else), and run `removeLabelledResources` for their owners in `afterAll` or the scenario teardown.
    - Pros: the leak cannot start; no Docker calls in ordinary unit runs; the backstop covers a harness that does probe on purpose.
    - Cons: a new service flag is public surface; `NODE_ENV=development` in `cli.test.ts` exists to test bridge-path resolution, so that test needs the flag rather than a different `NODE_ENV`.
  - **Only clean up in teardown.**
    - Pros: no backend change.
    - Cons: a watchdog kill or SIGKILL skips `afterAll`, which is exactly how these leaked.

### 3. Owner reaper also removes networks

**Problem.** A real backend that crashes mid-check keeps its one leaked network until its next check. The doc comment of `reapStaleProbes` says "probe containers and networks", but the method removes only containers.

**Context.** `createProbeNetwork` already removes a same-owner leftover before creating (`container-host-reachability.ts:1069-1070`), so a stable owner leaks at most one network.

**Investigation.** `reapStaleProbes` (`container-host-reachability.ts:1133-1158`) lists only `docker ps -a` with the owner and role labels. Its comment at `:1133` is inaccurate. The shutdown handler does not track in-flight probes.

**Decisions.**

- **Where to reclaim a stable owner's network?**
  - **Extend `reapStaleProbes` to unattached networks of its own owner and role (recommended).**
    - Pros: matches the comment; one owner-scoped listing; safe on a shared daemon.
    - Cons: does not help one-off owners (task 2 does); one more `docker network ls` per check.
  - **Also remove the in-flight network in the SIGTERM drain.**
    - Pros: covers graceful stops, including the harness case.
    - Cons: adds Docker work to shutdown, which must stay bounded; does nothing for SIGKILL.

### 4. Qualification: no new probe networks after a full run

**Problem.** Nothing yet proves the leak has stopped.

**Context.** This is the file's only qualification item.

**Investigation.** The probe-network list is the measure: 29 networks today, none newer than 2026-10-26 09:11 UTC.

**Decisions.**

- **What run counts as a pass?**
  - **Snapshot the label list, run `mise run test` and `test:cli:scenarios` plus the live suites on Linux, and compare (recommended).**
    - Pros: covers both candidate sources and the suites the file names.
    - Cons: `mise run test` has had the production backend SIGKILLed on this host (see AGENTS.md), so it needs a quiet window or another machine.
  - **Only the live Docker suites in CI.**
    - Pros: disposable runners; no risk to the production backend.
    - Cons: CI runners are fresh, so a leak there leaves no trace to observe, and the scenario harness does not run there.

### 5. Owner-agnostic sweep (open question)

**Problem.** Networks from owners that no longer exist have no reaper, and this host is at its pool limit again.

**Context.** The file's constraint: never remove a network whose owner is not provably dead. `disk:report` is read-only (`mise.toml:302-305`, `scripts/disk-report.ts`) and has no `--fix`, contrary to what the question suggests. `dev:prune` removes profiles, not Docker networks.

**Investigation.** None of the 29 networks has a container attached. Probe networks are created and removed within one check, so an unattached probe network older than a few minutes cannot belong to a check still in progress.

**Decisions.**

- **Should a sweep remove old unattached probe networks whatever their owner?**
  - **Yes, report them in `disk:report` and remove them only through an explicit, reviewed command (recommended).** Select by the probe role label, no attached containers, and an age of over a day, then remove each one by name.
    - Pros: a probe network holds no data and is single-use by design, so the constraint's risk does not apply; it frees the pools on hosts like this one.
    - Cons: a new Docker-touching path in a tool that is read-only today.
  - **No, keep removal owner-scoped only.**
    - Pros: the strictest reading of the constraint.
    - Cons: the backlog that already exists on this host is never reclaimed without hand work.

## Assumptions and decisions

Made 2026-10-28 while implementing this file together with
[0730](0730-cli-tests-leak-probe-networks.md).

### Task 1: confirming the source

- **Chose:** the code reading, carried by 0730, plus a live check of the fix
  on this machine; the per-harness owner correlation is left for a Linux host.
- **Why:** the work ran on macOS (Docker Desktop 29.9.2).
  `ContainerHostReachabilityService.runCheck` returns `not-linux` before any
  Docker call off Linux, so neither harness can create a probe network here,
  and a before/after diff would prove nothing. Running `cli.test.ts` here left
  the probe-network count at 0 before and after, which is expected and not
  evidence. The recommended correlation needs omarchy-hp or another Linux host.

### Task 2: harness cleanup

- **Chose:** the recommended "disable the boot probe for harness backends"
  half, through the internal switch `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`
  that 0730 task 3 recommends rather than a public service flag. The `afterAll`
  backstop by owner label was not added.
- **Why:** 0730's later, more specific analysis prefers the environment switch
  (no public CLI surface, no `NODE_ENV` change). With the switch on, no harness
  backend starts a boot probe. A probe started later (a container scenario on
  a rootless daemon) is now settled by the backend's own shutdown (0730 task
  2). A backstop would put Docker calls into every ordinary CLI unit run,
  which the recommended option lists as a pro to avoid. It would also need the
  backend's owner derivation in the CLI package, and a SIGKILL or watchdog
  kill skips `afterAll` anyway.

### Task 3: the owner reaper

- **Chose:** the recommended option. `reapStaleProbes` removes probe
  containers first, then lists networks with the owner and probe-role labels
  and removes each one by name, one per call. Only names starting with
  `ork-<owner>-reach-` are removed.
- **Why:** Docker refuses to remove a network with an attached container, so
  only unattached networks go; one per call keeps one refusal from skipping
  the rest (the lesson in `container-live-cleanup.ts`). The name check is
  belt and braces on top of the exact owner label filter. Live on Docker
  Desktop it removed a leftover of its own owner and left another owner's
  probe network in place.

### Tasks 2 and 3: shutdown races and cleanup failures (2026-10-29)

- **Chose:** wait for network preparation through its existing command deadline
  before shutdown removes the network, check for closure before launching
  probes, and clean up late network and container completions. Remove tracked
  containers one per call, retry failed container removals and the network once
  if Docker refuses the network, and keep stale-container removals independent.
- **Why:** removing a name before Docker creates it can report not found and
  then leak the later resource; one failed container removal must not skip
  others or strand their network. Calls remain bounded. If preparation exceeds
  even its command deadline, its continuation cleans up when it eventually
  settles; an unresponsive daemon or SIGKILL still requires the owner reaper.
  Deterministic fake-runner cases cover these races and failure paths. Task 4's
  Linux qualification remains open.

### Task 5: the owner-agnostic sweep

- **Chose:** nothing; left open for the user, as asked. The host's existing
  networks were not touched.

Seen on omarchy-hp while qualifying todo 0058 (retired on 2026-10-29).

## Current state

- `ContainerHostReachabilityService` (`apps/backend/src/core/container-host-reachability.ts`)
  creates `ork-<owner>-reach-probe-net` per check (`createProbeNetwork`) and
  removes it in a `finally`. A process killed during the check (a test
  watchdog, a timeout, a crash) leaves the network behind.
- `createProbeNetwork` removes a leftover only for its own owner name, and
  `reapStaleProbes` removes stale probe **containers** of its own owner, never
  networks. A real backend's owner is stable, so it leaks at most one network.
  Tests use a temporary data directory per run, so each leaked owner is never
  seen again and nothing removes its network.
- On 2026-10-26 the daemon held 29 unattached probe networks labelled
  `orkestrator-resource-role=host-reachability-probe`, all created on
  2026-09-28 by owners that no data directory on the host maps to (not the
  live instance `fa3e5358402ef5a5`, not `orkestrator-v2-dev`). With the bridge
  network they used all 31 default address pools, so every
  `createDockerContainer` failed with `resource-exhausted: Docker has no free
  address range for another environment network`. That blocks every live
  Docker suite and, on that host, any new environment of the live instance.
- To run the 0058 live cases, the eight oldest were removed (names below).
  Within minutes another run on the host leaked four more
  (`ork-ba077af2d5d36602`, `ork-74e3e0fcfc850592`, `ork-2b4ccf00afa71af0`,
  `ork-17b9c6e937ff5d30`, created 2026-10-26 00:51:56–00:52:06 UTC), so the
  removed eight were not recreated: the pool had only three free ranges left.
  Removed: `ork-b974e29e59930c3f`, `ork-830a1d1e2d22673e`,
  `ork-3b48ede1779a3e26`, `ork-2abb06b89c192705`, `ork-4bd4cb1fa5510280`,
  `ork-9b95783bb81bd7ab`, `ork-ce8a386c965921c8`, `ork-f842d66a53acec29`
  (each `-reach-probe-net`, bridge driver, no containers).
- On 2026-10-30, while qualifying todo
  [0870](0870-container-start-poll-quantisation.md), omarchy-hp's daemon
  again held 29 unattached probe networks, all 31 default pools in use. All
  were created on 2026-10-28 between 18:22 and 20:20 UTC, before the
  shutdown fix (#1419) merged at 01:29 UTC on 2026-10-29, so they fit the
  known leak rather than a new source. They were not touched. Every live
  suite and the benchmark failed or could not create an environment network
  until they are removed, which task 5 or a hand removal has to decide.

## Outstanding work

### Code

Items 1 to 3 are done (2026-10-28); see the Tasks list and
[0730](0730-cli-tests-leak-probe-networks.md).

1. Find which test leaks them. Three more appeared at 00:58:00–08 UTC while
   a plain `mise run test` (no live Docker suites enabled) was killed by a
   host-wide agent restart, so an ordinary suite creates them, not only
   `apps/backend/tests/container-live-readiness.test.ts` (C22). The likeliest
   source is `ContainerHostReachabilityService.check("boot")`, which every
   backend runs at start (`apps/backend/src/core/index.ts`) unless
   `NODE_ENV` is `test`: a test that boots a real backend with another
   `NODE_ENV` and a temporary data directory starts a probe and is then
   killed. Several networks within seconds fits several such backends.
2. Make the leaking suite remove probe networks by its owner label in
   `afterAll`, like `container-live-replacement.test.ts` removes its
   environment networks.
3. Have `reapStaleProbes` also remove unattached probe networks of its own
   owner, so a backend that crashed mid-check recovers its one network on the
   next check rather than only on the next probe network create.

### Qualification

- After a full `mise run test` plus the live Docker suites on a Linux host,
  `docker network ls --filter label=orkestrator-resource-role=host-reachability-probe`
  lists nothing new.

## Constraints and rationale

- Removing networks whose owner is not provably dead is unsafe on a shared
  daemon; only the creating run (by its owner label) or an owner's own reaper
  may remove them.

## Open questions

- Should a sweep (for example `mise run dev:prune` or `disk:report --fix`)
  offer to remove unattached probe networks older than a day whatever their
  owner?

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md) (test leaks)
- [0061-container-qualification-follow-ups.md](0061-container-qualification-follow-ups.md) (harness leaks)
- [0730-cli-tests-leak-probe-networks.md](0730-cli-tests-leak-probe-networks.md): the graceful-shutdown leak and the two CLI harness sources

## Replaces

Nothing; new observation.
