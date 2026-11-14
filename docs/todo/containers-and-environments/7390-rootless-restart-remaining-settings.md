# Rootless daemon restart: the settings not yet run

## Task analysis

Analysed 2026-11-06 against main at `c1724ab74`; tasks 1 and 2 acted on
2026-11-11 against main at `498b68766`
([evidence](../../development/container-qualification.md#rootless-daemon-restart-with-live-restore-and-on-gvisor-tap-vsock-and-the-7549-re-checks-2026-11-11)).
Found while closing
to-do 0018 (retired 2026-11-11) task 2 with
to-do 4730 task 3 (retired 2026-11-10; the launcher is in [container qualification](../../development/container-qualification.md#disposable-docker-daemon)).

### Tasks

1. **Rootless restart with `live-restore` on**: what happens to running gateway runtimes when a rootless daemon restarts with `live-restore` enabled. Status: done (2026-11-11).
2. **Rootless restart on the other RootlessKit network drivers**: gvisor-tap-vsock now (built into the launcher's RootlessKit), then pasta and VPNKit once a host has their binaries. Status: gvisor-tap-vsock done (2026-11-11); pasta and VPNKit blocked (waits on 7568: 7390 task 2, the user installing `passt` and a `vpnkit` binary on beelink; decided 2026-11-14).

### 1. Rootless restart with `live-restore` on

**Problem.** The rootless daemon restart passed only with `live-restore`
off. With it on, the rootful run of 2026-10-31 kept both containers running
in the same namespace. A rootless restart replaces RootlessKit and its
network namespace, so containers kept alive by `live-restore` may survive
without a working network, or with their gateway's rules in a namespace that
no longer routes. Observed on 2026-11-11: neither (Investigation).

**Context.** `container-live-egress-conditions.test.ts` already had the
`live-restore` branch from the rootful run: it expects both containers to
keep running with the gateway's `StartedAt` unchanged, the policy enforced,
a manual refresh working and `prepareEgressGatewayForStart` returning
`ready`. The launcher's rootless mode refuses `--live-restore` (only
`--mode rootful` takes it), because its restart replaces the whole
RootlessKit tree.

**Investigation.** On 2026-11-06 a `restart` of the launcher's daemon gave
RootlessKit a new pid, a new network namespace inode and a new slirp4netns
process. The launcher's stop sweep kills only processes carrying its
instance marker, which container processes do not inherit, so a run has to
find surviving container processes itself.

Run on 2026-11-11 on beelink (kernel 7.1.8, disposable rootless Engine
29.9.2, slirp4netns, containerd store), with the instance's `daemon.json`
set to `"live-restore": true` before a `restart` (`docker info` reported
`LiveRestoreEnabled: true`). After the restart:

- the new daemon reported both the gateway and the runtime exited: no shim
  survived RootlessKit, so the rootful branch's first assertion (the
  gateway still running) cannot hold;
- both containers' processes were still running (7 in the gateway's pid
  namespace, 3 in the runtime's), in the old user and network namespaces,
  unknown to any daemon;
- from inside the orphaned gateway's network namespace, `curl` to the
  allowed registry's address exited 7: slirp4netns went with the old
  RootlessKit, so the orphans have no network at all;
- once the orphans were killed (pid, start time and the cgroup naming the
  container id checked first), the backend's start path brought both up
  with the policy enforced, exactly as with `live-restore` off.

The case now has a rootless `live-restore` branch that asserts this,
records the survivors (`ORKESTRATOR_QUALIFICATION_EVIDENCE`) and reaps them;
it passed 1/1. Its first run failed earlier, on four automatic-port
collisions in a row after the first restart, which is
[7549](7549-rootless-docker-cp-refusals.md) task 4, not this behaviour.

**Decisions.**

Done 2026-11-11. The product cannot keep anything alive across a rootless
restart, and the orphans it leaves keep running on the same volumes the
restarted containers mount, out of every daemon's reach. The backend now
warns once per process when a rootless daemon reports `live-restore` on
(`docker` `daemon.rootless-live-restore`, from the capacity probe), naming
the remedy; restarting the containers needs no change.

- **What is the pass criterion?**
  - **Run the existing case unchanged and record which assertions fail, then decide whether the product needs a change (recommended).**
    - Pros: uses the assertions already written for the rootful result, and shows the real behaviour before anyone designs around it.
    - Cons: a failure first needs reading, not fixing; the case may need a rootless branch once the behaviour is known.
  - **Write a rootless-specific expectation first.**
    - Pros: a green run at once.
    - Cons: it would encode a guess about RootlessKit that nobody has observed.
- **Does the product need a change?**
  - **Warn once when a rootless daemon has `live-restore` on, and restart the containers as for any daemon without it (recommended).**
    - Pros: small; the user learns that the setting does nothing on
      rootless and leaves processes behind; no change to the start path,
      which already recovers.
    - Cons: a log line, not a UI notice; the orphans of a past restart still
      need the user (or a reboot) to end them.
  - **Find and kill the orphans from the backend.**
    - Pros: no leftover processes.
    - Cons: the backend would signal processes no daemon owns, identified
      only by cgroup names; against this repository's rule of signalling
      only processes it spawned.
  - **Refuse to create containers on such a daemon.**
    - Pros: the hazard cannot arise.
    - Cons: blocks a daemon that works until it is restarted, over a
      setting the user may never exercise.

### 2. Rootless restart on the other RootlessKit network drivers

**Problem.** Only slirp4netns ran. VPNKit, pasta and gvisor-tap-vsock
rebuild the namespace differently, and the backend's RootlessKit host
address (`10.0.2.2`) did not answer on VPNKit on 2026-11-04.

**Context.** The launcher takes `--net vpnkit`, `--net pasta` and
`--net gvisor-tap-vsock`. Its pinned tools include RootlessKit (which has
gvisor-tap-vsock built in) and slirp4netns; neither `vpnkit` nor `pasta`
binaries are pinned, so those runs need them on `PATH`. Installing them on a host is a host change for the user; on 2026-11-14 the user chose beelink and installs them there (packages only), a [manual-test checklist](../manual-test/7568-manual-test-checklist.md) item (7390 task 2). The gvisor-tap-vsock run needed nothing installed.

**Investigation.** The default `dockerd-rootless.sh` picks slirp4netns,
then pasta, then VPNKit, then gvisor-tap-vsock, so a user without
slirp4netns installed gets a different driver from the one qualified.

On 2026-11-11 the restart case passed 1/1 on gvisor-tap-vsock (beelink,
kernel 7.1.8, disposable rootless Engine 29.9.2, `--net gvisor-tap-vsock`,
`live-restore` off) with the same assertions as slirp4netns: after each
restart Docker started neither container and the backend's start path
brought both up with the policy enforced. Neither `pasta` nor `vpnkit` is
on beelink's `PATH`, so those two still wait on
[7568](../manual-test/7568-manual-test-checklist.md) (7390 task 2).

Steps left: once a host has the binaries, `mise run docker:disposable --
start --net pasta` (then `--net vpnkit`), and run the restart case as in
the evidence above.

**Decisions.**

- **Which drivers to run?**
  - **gvisor-tap-vsock first, because it is the fallback a host with nothing installed gets, then pasta (recommended).**
    - Pros: covers what a user gets by default on a bare host, with no extra download.
    - Cons: gvisor-tap-vsock is marked experimental by RootlessKit.
  - **VPNKit first, to match the 2026-11-04 run.**
    - Pros: comparable with that day's firewall results.
    - Cons: VPNKit's host-service path is already known to be blocked, and Docker's rootless extras no longer ship it.

## Current state

- With `live-restore` off, a rootless restart passes on slirp4netns
  (2026-11-06) and gvisor-tap-vsock (2026-11-11).
- With `live-restore` on, a rootless restart keeps nothing: the daemon
  reports every container exited and the old processes linger with no
  network; the backend restarts the containers and warns about the setting.

## Outstanding work

- Task 2: the pasta and VPNKit runs on beelink, once the user has installed
  `passt` and `vpnkit` there (7568).

## Assumptions and decisions

### Task 2: the binaries go on beelink (user decision, 2026-11-14)

The user (maintainer) decided on 2026-11-14 that `passt` (for `pasta`) and a
`vpnkit` binary are installed on beelink, packages only, with no firewall or
network change, and that the user installs them. That stays a manual-test
checklist item, shared with 6101 task 4. The pasta and VPNKit restart runs
are agent work that waits on it.

### `live-restore` set in the instance's `daemon.json`, not through the launcher (task 1)

Chose: keep the launcher refusing `--live-restore` in the rootless mode and
set `"live-restore": true` in one disposable instance's `daemon.json` before
a `restart`. Why: the refusal is right for normal use (a restart there
leaves container processes the launcher cannot identify by its marker), and
the test reaps the orphans itself; the record keeps `liveRestore: false`,
which is what lets `restart` run.

### A warning, not an orphan sweep (task 1)

Chose the warning, per the recommendation above. Why: the start path
already recovers, and killing processes no daemon owns would break the rule
of signalling only processes the backend spawned.

## Related

- To-do 0018 (retired 2026-11-11), task 2: the rootless restart result these settings extend; the gateway's qualification as a whole is summarised in [container qualification](../../development/container-qualification.md#egress-gateway-on-linux-engine-qualification-closed-2026-11-11).
- To-do 4730 (retired 2026-11-10; the launcher is in [container qualification](../../development/container-qualification.md#disposable-docker-daemon)): the launcher.
- [Container qualification](../../development/container-qualification.md#rootless-daemon-restart-on-a-disposable-daemon-2026-11-06): the 2026-11-06 run.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 3, the arm64 host run; the user part of task 2: installing `passt` and `vpnkit` on a host) moved there on 2026-11-10.

## Replaces

Nothing; new work found while closing 0018 (retired 2026-11-11) task 2.
