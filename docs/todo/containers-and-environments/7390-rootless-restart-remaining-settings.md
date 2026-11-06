# Rootless daemon restart: the settings not yet run

## Task analysis

Analysed 2026-11-06 against main at `c1724ab74`. Found while closing
[0018](0018-container-network-and-credential-isolation.md) task 2 with
[4730](4730-disposable-docker-daemon-for-live-suites.md) task 3.

### Tasks

1. **Rootless restart with `live-restore` on**: what happens to running gateway runtimes when a rootless daemon restarts with `live-restore` enabled. Status: open.
2. **Rootless restart on the other RootlessKit network drivers**: VPNKit, pasta and gvisor-tap-vsock. Status: open.
3. **Rootless restart on arm64**: the same case on an aarch64 host. Status: open.

### 1. Rootless restart with `live-restore` on

**Problem.** The rootless daemon restart passed only with `live-restore`
off. With it on, the rootful run of 2026-10-31 kept both containers running
in the same namespace. A rootless restart replaces RootlessKit and its
network namespace, so containers kept alive by `live-restore` may survive
without a working network, or with their gateway's rules in a namespace that
no longer routes. Nothing has observed which.

**Context.** `container-live-egress-conditions.test.ts` already has the
`live-restore` branch: it expects both containers to keep running with the
gateway's `StartedAt` unchanged, the policy enforced, a manual refresh
working and `prepareEgressGatewayForStart` returning `ready`. The launcher
starts a daemon with `--live-restore`
(`mise run docker:disposable -- start --live-restore`).

**Investigation.** Not run. On 2026-11-06 a `restart` of the launcher's
daemon gave RootlessKit a new pid, a new network namespace inode and a new
slirp4netns process. Whether container processes survive RootlessKit's exit
at all is not known; the launcher's stop sweep kills only processes carrying
its instance marker, which container processes do not inherit, so a run must
check for surviving container processes itself afterwards.

**Decisions.**

- **What is the pass criterion?**
  - **Run the existing case unchanged and record which assertions fail, then decide whether the product needs a change (recommended).**
    - Pros: uses the assertions already written for the rootful result, and shows the real behaviour before anyone designs around it.
    - Cons: a failure first needs reading, not fixing; the case may need a rootless branch once the behaviour is known.
  - **Write a rootless-specific expectation first.**
    - Pros: a green run at once.
    - Cons: it would encode a guess about RootlessKit that nobody has observed.

### 2. Rootless restart on the other RootlessKit network drivers

**Problem.** Only slirp4netns ran. VPNKit, pasta and gvisor-tap-vsock
rebuild the namespace differently, and the backend's RootlessKit host
address (`10.0.2.2`) did not answer on VPNKit on 2026-11-04.

**Context.** The launcher takes `--net vpnkit`, `--net pasta` and
`--net gvisor-tap-vsock`. Its pinned tools include RootlessKit (which has
gvisor-tap-vsock built in) and slirp4netns; neither `vpnkit` nor `pasta`
binaries are pinned, so those runs need them on `PATH`.

**Investigation.** Not run. The default `dockerd-rootless.sh` picks
slirp4netns, then pasta, then VPNKit, then gvisor-tap-vsock, so a user
without slirp4netns installed gets a different driver from the one
qualified.

**Decisions.**

- **Which drivers to run?**
  - **gvisor-tap-vsock first, because it is the fallback a host with nothing installed gets, then pasta (recommended).**
    - Pros: covers what a user gets by default on a bare host, with no extra download.
    - Cons: gvisor-tap-vsock is marked experimental by RootlessKit.
  - **VPNKit first, to match the 2026-11-04 run.**
    - Pros: comparable with that day's firewall results.
    - Cons: VPNKit's host-service path is already known to be blocked, and Docker's rootless extras no longer ship it.

### 3. Rootless restart on arm64

**Problem.** The rootless results are all x86_64. The gateway's firewall
depends on kernel modules (`ip_set`, `xt_set`, `nf_tables`) that an arm64
kernel may build differently.

**Context.** The launcher pins aarch64 digests for the rootless extras and
slirp4netns, but has run only on x86_64.

**Investigation.** Not run; no arm64 rootless host was available.

**Decisions.**

- **Where to run it?**
  - **A self-managed arm64 Linux host with the launcher, when one is available (recommended).**
    - Pros: the same command and suite as x86_64.
    - Cons: needs such a host.
  - **A rootless job on `ubuntu-24.04-arm` CI.**
    - Pros: repeatable.
    - Cons: 0018 task 2 decided against a rootless CI job for now; restarting the daemon there would also stop the runner's other containers.

## Related

- [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md), task 2: the rootless restart result these settings extend.
- [4730-disposable-docker-daemon-for-live-suites.md](4730-disposable-docker-daemon-for-live-suites.md): the launcher.
- [Container qualification](../../development/container-qualification.md#rootless-daemon-restart-on-a-disposable-daemon-2026-11-06): the 2026-11-06 run.

## Replaces

Nothing; new work found while closing 0018 task 2.
