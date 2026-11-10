# Disposable Docker daemon for live qualification

## Task analysis

Analysed 2026-11-04 against main at `c22a06060`; tasks 1 to 3 acted on
2026-11-06 against main at `c1724ab74`; task 1's nested rootful mode built
2026-11-09 against main at `c6de4733c`, which added task 4.

### Tasks

1. **Repo-owned disposable daemon launcher**: start, use and remove a private Docker daemon with one command. Status: done (the host rootless daemon on 2026-11-06; the nested rootful mode, `--mode rootful`, on 2026-11-09).
2. **Keep the default-loopback fixture**: the 2026-11-04 rootless host-loopback check exists only in a git-ignored folder. Status: done 2026-11-06 (`apps/backend/tests/container-live-rootless-loopback.test.ts`, passed 1/1).
3. **Rootless daemon restart with runtimes**: the check [0018](0018-container-network-and-credential-isolation.md) task 2 still owes. Status: done 2026-11-06 (passed 1/1 on the launcher's daemon; result recorded in 0018 task 2).
4. **Run the nested rootful mode on a rootful host daemon**: the 2026-11-09 live runs had only a rootless outer daemon. Status: open (needs a host where the user may use the rootful daemon).

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

**Result (2026-11-06).** Built the host rootless half:
`scripts/disposable-docker-daemon.ts`, run as `mise run docker:disposable --
<start|restart|stop|env|status|load-image>`. It runs the host's `dockerd`
under RootlessKit 3.3.0 (Docker's 29.9.2 rootless extras) and slirp4netns
1.3.3, both downloaded into the git-ignored `output/disposable-docker/tools/`
and checked against pinned SHA-256 digests. Each instance has its own data
root, exec root, socket, pid file, `HOME` and `XDG_RUNTIME_DIR`; `start`
prints `DOCKER_HOST`, `ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK` and
`ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`; `--image` and `load-image` stream
`docker save` into `docker load` by reference and check the id; `stop`
removes everything it made, and `start` reaps its own stale instances.
Processes are signalled only after their recorded start time and an
instance marker in their environment match. `tests/unit/disposable-docker-daemon.test.ts`
(13 tests) covers it without Docker. Live on beelink: start 4.8 s, a
5.45 GB image copy 97 s, restart about 3.5 s, stop 7 s with nothing left.
The guide's [Disposable Docker daemon](../../development/container-qualification.md#disposable-docker-daemon)
documents it. The nested rootful mode (`docker:29-dind`) is not built; see
Assumptions and decisions.

**Result (2026-11-09).** Built the nested rootful mode behind the same
commands: `mise run docker:disposable -- start --mode rootful` runs
`docker:29.9.3-dind` (pinned by index digest) as one privileged container on
the outer daemon (`--outer-host`, else `DOCKER_HOST`, else the context; a
local Unix socket only, Docker Desktop refused), on the outer default bridge
so no outer pool or network is needed. Its own volume holds the data root,
its socket sits in the instance's `0700` runtime directory, and a supervisor
loop restarts `dockerd` and counts generations. `restart` (the printed
`ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`) sends SIGTERM to the inner
`dockerd` and waits for the next generation to answer. `--ipv6` and
`--live-restore` reproduce the 2026-10-31 settings, and a shared directory
mounted at the same path covers suites that bind-mount temporary files.
Every outer object carries the instance's random marker as a label, and
`stop` removes the container, root-owned leftovers (through a throwaway
container), the volume and the dind image only if this instance pulled it.
`start` now also prints `ORKESTRATOR_DISPOSABLE_DOCKER_MODE`. Code in
`scripts/disposable-docker-daemon-nested.ts`;
`tests/unit/disposable-docker-daemon-nested.test.ts` (13 tests, fake Docker
CLI) covers it, and the 21 rootless tests still pass.

Live on beelink2 (Arch Linux, kernel 7.2.15, x86_64, host Engine 29.9.2),
with the launcher's own rootless daemon as the outer daemon, because this
user is not in the `docker` group and cannot reach the host daemon (task 4):
- `start --mode rootful --image ghcr.io/orkestrator-ai/orkestrator-v2:2.37.3-beta`
  (the published image of `480cf0296`; `docker/` unchanged since): 2 min 15 s
  including the dind pull and a 6.0 GB copy. `docker info` on the inner
  daemon: Engine 29.9.3, no `rootless` security option. An inner container
  got `10.213.0.2` and reached `registry.npmjs.org` (200).
- `container-live-egress-conditions.test.ts` with the printed restart
  command: **3 of 3 pass** (55 assertions), twice; each run restarted the
  inner `dockerd` twice (supervisor generations 1 to 5).
- The same suite on a `--ipv6` instance: **3 of 3 pass** (66 assertions:
  IPv6 12, DNS rotation 25, daemon restart 29), the counts of the hand-built
  2026-10-31 run.
- One printed restart by hand: 12.5 s with a `sleep` container running
  (stopped, exit 137, as `live-restore` is off); 2.3 s on a `--live-restore`
  instance, where the container kept running.
- `stop`: 3.9 s and 4.6 s, leaving no container, volume, dind image,
  instance or runtime directory on the outer daemon or the host.
- The suite on a `--live-restore` instance: **3 of 3 pass** (63
  assertions; daemon restart 37, as on 2026-10-31). The first two attempts
  failed 2 of 3 because the host's unauthenticated GitHub limit was spent
  (the gateway's `api.github.com/meta` fetch got 403); the pass is the rerun
  after the reset.
- `container-live-readiness.test.ts` C09 "restart during launch" and C10,
  with `TMPDIR` on the printed shared directory: **2 pass**, where both had
  failed on the hand-built nested daemon on 2026-11-06 without it.
- The guide's [record](../../development/container-qualification.md#nested-rootful-disposable-daemon-on-beelink2-2026-11-09)
  has the details.

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

**Result (2026-11-06).** The 2026-11-04 file was lost with its worktree, so
the check was rewritten from the guide's description as
`apps/backend/tests/container-live-rootless-loopback.test.ts`. It needs
`RUN_LIVE_DOCKER_TESTS=1`, an image and
`ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK=disabled` (the launcher prints it),
and skips unless `docker info` also reports rootless. On the launcher's
daemon it passed 1/1 (7 assertions): `blocked`, `dockerRootless: true`, the
`DISABLE_HOST_LOOPBACK=false` remediation, and `refused` from a gateway
runtime. Against the rootful host daemon it skipped 1/1.

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

**Result (2026-11-06).** Run with the recommended criterion on the
launcher's default daemon (slirp4netns, host loopback disabled,
`live-restore` off) and `orkestrator-v2:dev-f199d298c1eb`: the
daemon-restart case passed 1/1 and the whole egress-conditions suite 3/3.
The expectation in the investigation held: a restart replaced RootlessKit,
its network namespace and slirp4netns. The result is recorded under 0018
task 2. VPNKit, the other drivers and `live-restore` on were not run
([7390](7390-rootless-restart-remaining-settings.md)).

### 4. Run the nested rootful mode on a rootful host daemon

**Problem.** The nested rootful mode has run live only inside the launcher's
own rootless daemon. There the privileged container is privileged only in the
outer daemon's user namespace, so a privileged dind on a host's rootful
daemon (the case the mode exists for) has not been observed through the
launcher.

**Context.** On beelink2 the host daemon's socket is `root:docker` mode
`0660` and the `docker` group has no members, so this user cannot reach it,
and changing group membership needs `sudo` with a password. The hand-built
equivalent ran on beelink's rootful daemon on 2026-10-31 and 2026-11-06.
To-do [6820](6820-agent-tools-peer-gate-linux-evidence.md) may want this
daemon for its Linux Engine evidence.

**Investigation.** Code paths that differ on a rootful outer daemon: the
socket is owned by root with the caller's gid as its group (the rootless
outer made it the user's), and files inner root processes leave in the
runtime or shared directory are root-owned, which `stop` removes through a
throwaway container (covered by a unit test with a fake CLI, not live).
Everything else ran live on 2026-11-09.

Review follow-up (2026-11-10): task 4 remains blocked on this host. The
current user is uid/gid 1000, in groups 1000 and wheel (998); the host
socket is root:docker, mode 0660, and the user cannot read or write it.
No group, sudo or host-daemon configuration change was made. Socket group
access, real root-owned leftovers, restart and final resource absence on
a rootful outer daemon still need the recommended host run.

Observed in passing (2026-11-10, to-do
[6820](6820-agent-tools-peer-gate-linux-evidence.md) task 1, on beelink,
where this account may use the host's rootful Engine 29.9.2): `start --mode
rootful --name s6820rf` recorded `outerRootless: false`, started in 12.9 s
including the dind pull, served two runs of the peer evidence script, and
`stop` left no labelled container or volume, no dind image and no runtime
directory. Neither the suites this task names nor the printed restart ran
there, and no root-owned leftover was checked, so the task stays open.

**Decisions.**

- **Where to run it?**
  - **On beelink or omarchy-hp, where earlier rootful runs had the host daemon (recommended).**
    - Pros: one `start --mode rootful`, the egress-conditions suite with
      `--ipv6`, and a `stop` followed by a check that nothing labelled
      `orkestrator-disposable-docker` remains; directly comparable with
      2026-11-09.
    - Cons: needs a free slot on that host and access to its daemon socket.
  - **Give the beelink2 user access to the host daemon.**
    - Pros: the same host as the 2026-11-09 run.
    - Cons: a host change that needs the owner's password and decision;
      `docker` group membership is root-equivalent on the host.

## Current state

- Live suites can target any daemon through `DOCKER_HOST`, and
  `mise run docker:disposable -- start` provides a private host rootless one
  (2026-11-06) or, with `--mode rootful`, a nested rootful `docker:29-dind`
  (2026-11-09). Neither touches the host daemon's configuration, pools or
  networks.
- Live egress-gateway suites fetch GitHub's ranges from `api.github.com/meta`
  without credentials, at about 7 requests per egress-conditions run, so
  repeated runs on one host can use up GitHub's 60 an hour and fail every
  gateway with "could not apply its network policy". Check
  `curl -s https://api.github.com/rate_limit` (which does not count against
  the limit) before reading such a failure as a regression.
- On 2026-11-04 beelink's shared daemon held 32 networks, 29 of them unattached host-reachability probe networks from 2026-10-31 to 2026-11-02. That is why its pools are full. To-do 3320 (retired 2026-11-10) tracked them, and `mise run disk:report -- --fix probe-networks` clears them. A disposable daemon works around that for live suites and does not replace it: new environments on the shared daemon stay blocked until it runs.

## Outstanding work

- Task 4: a run of the nested rootful mode on a host's rootful daemon.

## Constraints and rationale

- Never restart, reconfigure or prune the shared daemon, and never remove its networks. Production Orkestrator runs on the same host.
- The launcher removes only what it recorded creating: its container or process by recorded id, and its own volume and data root. A PID read back from a file needs its identity confirmed first.
- Never retag `orkestrator-v2:latest`.
- Give the private daemon its own `default-address-pools` rather than explicit per-network subnets. 3320 records an explicitly subnetted network on which a restricted container's gateway failed to apply its policy, with the cause not investigated.
- Keep the socket in a private directory: access to it is root-equivalent over that daemon.

## Open questions

- Should `dev:test` profiles be able to use this daemon for `--fixture-environments container`? Not checked. It would unblock fixtures on a host with full pools, but the profile's bridges and ports were not designed around a second daemon.

## Assumptions and decisions

### Task 1: rootless first, rootful nested left open

(Superseded on 2026-11-09, when the nested rootful mode was built; kept as
the record of the 2026-11-06 choice.)

Chosen: build the host rootless daemon only, and keep the nested rootful
mode as the open half of task 1. The work this delegation had to do (task 3)
needed rootless, and rootless runs in RootlessKit's own user, mount and
network namespaces, so it cannot change the host's firewall, routes or
interfaces and needs no privileged container on the shared daemon. The
rootful recipe needs a privileged `docker:29-dind` on that daemon and an
image pull (`docker:29-dind` was not on beelink), which this run's safety
rules preferred to avoid.

### Task 1: the host's own Docker binaries, pinned rootless tools

Chosen: run the host's `dockerd`, `containerd` and `runc`, and download only
RootlessKit, `dockerd-rootless.sh` and slirp4netns, pinned by SHA-256.
beelink had no rootless extras or slirp4netns installed; installing packages
would change the host, while a pinned download into the worktree does not.
The daemon then matches the host's Engine version (29.9.2). The digests are
pinned for x86_64 and aarch64; only x86_64 has been run.

### Task 1: identity by start time and an environment marker

Chosen: record the RootlessKit parent's pid and start time at spawn, and set
a random instance marker in the daemon's environment that every descendant
inherits. A signal goes only to a process whose start time matches, or which
carries the marker. The marker also finds `dockerd`, `containerd` and the
shims if RootlessKit dies first, without matching processes by name.

### Task 1: the daemon keeps the user's session bus

Chosen: pass `DBUS_SESSION_BUS_ADDRESS` to the daemon although its
`XDG_RUNTIME_DIR` is private. Without it the systemd cgroup driver could not
create container scopes (first live run: "interactive authentication
required"); the cgroupfs driver would avoid the user's systemd manager but
cannot apply resource limits rootless on cgroup v2, which C24 asserts. The
scopes are transient and go with their containers.

### Task 1: the record keeps its runtime directory

Chosen: store the temporary directory used at start in the instance record.
The restart command runs inside the test runner, whose `TMPDIR` is private,
and recomputing the path there named a different directory; the launcher
correctly refused to remove it, but the daemon had already stopped and the
first restart run failed.

### Task 2: declared host loopback, detected rootless

Chosen: the test runs only when the caller declares
`ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK=disabled` and `docker info` reports
rootless. Docker does not expose RootlessKit's host-loopback setting, and
detecting it with a probe would be the same observation the test asserts.

### Task 3: an existing review image

Chosen: `orkestrator-v2:dev-f199d298c1eb`, whose firewall, gateway and
entrypoint scripts are identical to `c1724ab74`, rather than a 5.45 GB build
on the shared host; see 0018's decisions for the same choice.

### Task 1: nested rootful mode on an outer daemon chosen by socket

Chosen: run the dind container on the outer daemon named by `--outer-host`,
else `DOCKER_HOST`, else the current context, and accept only a local
`unix://` socket on Linux Engine. The container bind-mounts paths of this
machine, which a TCP, SSH or Docker Desktop endpoint would resolve
elsewhere. The outer endpoint is recorded at start because the restart
command runs inside suites whose `DOCKER_HOST` selects the inner daemon.

### Task 1: the outer default bridge, no network of its own

Chosen: `--network bridge` on the outer daemon. A network of its own would
need an address pool, and the shared daemon's pools are full on beelink
(to-do 3320, retired 2026-11-10).
The inner `bip` is `10.213.0.1/24` so it never overlaps the outer default
bridge's `172.17.0.0/16`.

### Task 1: restart by signalling the inner dockerd under a supervisor

Chosen: the container's entrypoint is a shell loop that runs `dind dockerd`
and starts it again when it exits, writing a generation number to the
runtime directory; `restart` sends SIGTERM to the inner `dockerd` through
`docker exec` and waits for the next generation to answer. Restarting the
container instead would also restart the supervisor and remount everything,
which is not what a host daemon restart does, and an in-container pid is
safe to signal because it is in the container's own pid namespace.

### Task 1: the socket in the private runtime directory

Chosen: bind-mount the instance's `0700` runtime directory and have
`dockerd` create its socket there with the caller's gid as its group. No TCP
listener, no TLS material, and only the caller can reach the socket.

### Task 1: a pinned dind image, removed only if this instance pulled it

Chosen: `docker:29.9.3-dind` by its index digest (the tag `29-dind`
resolved to it on 2026-11-09), pulled only when missing, with the pull
recorded before it starts. `stop` removes it only when this instance pulled
it and without `--force`, so Docker refuses while any other container uses
it and a copy someone else pulled is never removed.

### Task 1: removal by marker label, root-owned leftovers by container

Chosen: name and label the container and volume with the instance's random
marker, read the label back before every removal, and remove files the user
cannot delete with a throwaway `--network none` container of the same image
mounted on exactly those two directories. If the outer daemon does not
answer, `stop` fails and keeps the record rather than forget a container
that may still exist.

### Task 1: a rootless outer daemon for the live run

Chosen: run the live checks with the launcher's own rootless daemon as the
outer daemon. This user cannot reach beelink2's host daemon (task 4), and
it kept every object of the run inside daemons this work created. The
nested daemon then reports rootful but is root only inside the outer user
namespace, so the run proves the launcher and rootful `dockerd` behaviour
and leaves the rootful-host case to task 4. The image was the published
`ghcr.io/orkestrator-ai/orkestrator-v2:2.37.3-beta` (built from `480cf0296`,
no `docker/` change since), pulled without credentials.

### Task 1: review cleanup boundaries and lifecycle failure coverage

Chosen: derive the shared path from the instance directory, require both
recorded shared paths to match, and reject symbolic links or non-directory
roots before bind mounting or deleting. Invalid paths retain the record.
Trusting the recorded path would be simpler but lets cleanup leave its
instance boundary.

Chosen: retain an unknown nested state when inspection fails, skip it during
automatic reaping, and recheck the container before removal. Automatic removal
uses no force flag, so Docker can also refuse a container that starts after
inspection; explicit stop keeps its force-removal behavior. Treating errors
as stopped would make stale cleanup more aggressive but can terminate a live
suite.

Fake-CLI coverage now includes forged and symlinked shared paths for stop and
reap, one-shot inspection failures during reap and another start, a container
returning to running between inspections, reachable exited-container reaping,
and failed exec or missing generation advance during restart. Restart failures
keep the instance and allow a later retry and stop. These checks do not replace
task 4's real rootful-host evidence.

## Related

- [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md), task 2: owns the rootless qualification and task 3's result.
- [0019-container-platform-qualification.md](0019-container-platform-qualification.md): its daemon-wide restart could use the same launcher.
- Todo 0109 (retired on 2026-11-10): an earlier disposable rootless daemon recipe, recorded in [container qualification](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09).
- To-do 3320 (retired 2026-11-10): the pool exhaustion on the shared daemon; the sweep that clears it is in [disk usage](../../development/disk-usage.md#what-you-clean-yourself).
- [7390-rootless-restart-remaining-settings.md](7390-rootless-restart-remaining-settings.md): the rootless restart settings task 3 did not run.
- [6820-agent-tools-peer-gate-linux-evidence.md](6820-agent-tools-peer-gate-linux-evidence.md): Linux Engine evidence that may use either mode.

## Replaces

Nothing; new work found while retiring the rollout cap.
