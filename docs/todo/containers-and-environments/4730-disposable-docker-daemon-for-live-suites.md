# Disposable Docker daemon for live qualification

## Task analysis

Analysed 2026-11-04 against main at `c22a06060`.

### Tasks

1. **Repo-owned disposable daemon launcher**: start, use and remove a private Docker daemon with one command. Status: open.
2. **Keep the default-loopback fixture**: the 2026-11-04 rootless host-loopback check exists only in a git-ignored folder. Status: open.
3. **Rootless daemon restart with runtimes**: the check [0018](0018-container-network-and-credential-isolation.md) task 2 still owes. Status: open (depends on 1).

### 1. Repo-owned disposable daemon launcher

**Problem.** The live Docker suites need a daemon with free address pools, and some cases need one that can be restarted or reconfigured. The shared host daemon offers neither safely, so each qualification run builds its own private daemon by hand. Nothing in the repository reproduces one, so every run pays the setup again and can differ from the last.

**Context.** On 2026-11-04 the live readiness suite failed 7 of 7 on the shared daemon because its address pools were full, then passed 7 of 7 on a private rootless daemon. The live suites already follow `DOCKER_HOST`, which is how that run selected its daemon. The daemon-restart case in `container-live-egress-conditions.test.ts` runs only with `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`, and `container-live-qualification.yml` leaves it out because it needs a disposable daemon.

**Investigation.** The recipes exist only as prose in [container qualification](../../development/container-qualification.md):
- Rootful: `docker:29-dind` in a privileged container with its own volume, a private socket directory and a supervisor loop that restarts `dockerd` ([2026-10-31](../../development/container-qualification.md#egress-gateway-conditions-on-linux-engine-2026-10-31)).
- Rootless: a host rootless Engine with a private socket and data root, and pool `172.30.0.0/16` split into /24s, on VPNKit and slirp4netns, with host loopback on or off ([2026-11-04](../../development/container-qualification.md#rollout-cap-retirement-review-qualification-2026-11-04)). The rootless reviews of 2026-10-26 used similar setups.

The nearest code is `scripts/measure-registry-image.sh --dind`, which starts a throwaway labelled `docker:dind` for timing a pull. It runs nothing else against the daemon. `scripts/qualify-backend-upgrade-rollback.ts` takes a `DOCKER_HOST` but does not create a daemon.

On 2026-11-04 the qualification image was 5.45 GB, and `docker:29-dind` was not present on beelink.

**Decisions.**

- **Which daemon types should it start?**
  - **Rootful nested and host rootless, behind one interface (recommended).**
    - Pros: covers what has actually been needed: free pools and restarts from rootful, and the rootless topology that 0018 task 2 still owes. Both recipes have already worked on beelink.
    - Cons: two setups to maintain, and rootless needs host packages (`newuidmap`, subordinate id ranges, the rootless extras) that the launcher has to check for.
  - **Rootful nested only.**
    - Pros: one small script with no host prerequisites beyond Docker.
    - Cons: privileged on the shared daemon, and it cannot do task 3.
  - **Host rootless only.**
    - Pros: no privileged container, and it is a topology users really run.
    - Cons: not a rootful result, and RootlessKit's port and host-loopback behaviour would colour every failure.
- **How does the image reach the daemon?**
  - **Stream `docker save` into the private daemon's `docker load` by exact id, without retagging (recommended).**
    - Pros: tests the exact image under review, needs no registry, and leaves the shared daemon's tags alone. The 2026-11-04 run did this.
    - Cons: copies about 5 GB per daemon, so it costs disk and time on every start.
  - **Pull from the registry inside the daemon.**
    - Pros: no transfer from the host.
    - Cons: cannot test an unpublished image, which is the usual case for a review.
- **How is it exposed?**
  - **A mise task wrapping a script, which prints `DOCKER_HOST` and a stop command, with stop as a separate step (recommended).**
    - Pros: the caller runs any suite through `test:logged` as usual, matching the `dev:test` and `dev:stop` shape.
    - Cons: a killed run can leave a daemon behind, so start must reap its own leftovers by label.
  - **A wrapper that runs one command and always tears down.**
    - Pros: cannot be forgotten.
    - Cons: pays the image transfer again for every suite, and restart cases need the daemon to outlive one command.

### 2. Keep the default-loopback fixture

**Problem.** The 2026-11-04 evidence that a default rootless daemon reports `blocked` and keeps the runtime off the host came from a test that was never committed. It cannot be rerun from a clean checkout.

**Context.** The guide records it as `output/qualification-retirement/default-loopback.test.ts`, "not added to the deterministic suite". `output/` is git-ignored, so the file goes when that worktree does.

**Investigation.** The file is 3.2 KB. It binds an ephemeral host listener, calls the real `ContainerHostReachabilityService`, then creates a runtime through `createDockerContainer` and `prepareEgressGatewayForStart`. On a rootful daemon or a rootless one with host loopback enabled, its assertions would not hold.

**Decisions.**

- **Where should it live?**
  - **In `apps/backend/tests/` as an opt-in live test that skips unless the daemon reports rootless with host loopback disabled (recommended).**
    - Pros: rerunnable, and it follows the existing `RUN_LIVE_DOCKER_TESTS` convention. An explicit skip cannot pass by accident on the wrong daemon.
    - Cons: it does not run in CI, because hosted runners have no rootless daemon.
  - **Leave it out and rely on the recorded result.**
    - Pros: no new test.
    - Cons: the property cannot be rechecked after a RootlessKit or Engine bump.

### 3. Rootless daemon restart with runtimes

**Problem.** The egress gateway has passed a daemon restart on rootful Engine only. Whether a rootless restart leaves a runtime and gateway stopped, and whether the backend then starts them in order with the policy applied, is unproved. With the `ORKESTRATOR_EGRESS=in-container` cap removed, a failure here needs a release to fix.

**Context.** This is what remains of 0018 task 2, and the result belongs there. This file only supplies the daemon.

**Investigation.** Not run. The rootful run on 2026-10-31 used the same suite with `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND` pointed at a script restarting only the disposable daemon. Restarting a host rootless daemon is expected to restart RootlessKit and rebuild its network namespace too, which a nested rootful `dockerd` restart would not show. That is an expectation to check in this run, not something observed.

**Decisions.**

- **What is the pass criterion?**
  - **The same assertions as the 2026-10-31 run, with `live-restore` off, on slirp4netns with host loopback disabled (recommended).**
    - Pros: directly comparable with the rootful result, on the default loopback setting. Stated scope stays narrow.
    - Cons: leaves VPNKit and `live-restore` on unrun, so the record must say so.
  - **Every driver and setting combination.**
    - Pros: complete.
    - Cons: several runs for a secondary topology, and VPNKit's host-service path is already recorded as blocked.

## Current state

- Live suites can target any daemon through `DOCKER_HOST`.
- On 2026-11-04 beelink's shared daemon held 32 networks, 29 of them unattached host-reachability probe networks from 2026-10-31 to 2026-11-02. That is why its pools are full. [3320](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md) tracks them, and `mise run disk:report -- --fix probe-networks` clears them. A disposable daemon works around that for live suites and does not replace it: new environments on the shared daemon stay blocked until it runs.

## Constraints and rationale

- Never restart, reconfigure or prune the shared daemon, and never remove its networks. Production Orkestrator runs on the same host.
- The launcher removes only what it recorded creating: its container or process by recorded id, and its own volume and data root. A PID read back from a file needs its identity confirmed first.
- Never retag `orkestrator-v2:latest`.
- Give the private daemon its own `default-address-pools` rather than explicit per-network subnets. 3320 records an explicitly subnetted network on which a restricted container's gateway failed to apply its policy, with the cause not investigated.
- Keep the socket in a private directory: access to it is root-equivalent over that daemon.

## Open questions

- Should `dev:test` profiles be able to use this daemon for `--fixture-environments container`? Not checked. It would unblock fixtures on a host with full pools, but the profile's bridges and ports were not designed around a second daemon.

## Related

- [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md), task 2: owns the rootless qualification and task 3's result.
- [0019-container-platform-qualification.md](0019-container-platform-qualification.md): its daemon-wide restart could use the same launcher.
- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md): an earlier disposable rootless daemon recipe.
- [3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md): the pool exhaustion on the shared daemon.

## Replaces

Nothing; new work found while retiring the rollout cap.
