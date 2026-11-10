# Rootless Docker on gvisor-tap-vsock: probe RootlessKit's `10.0.2.1`

## Task analysis

Analysed 2026-11-09 against main at `c6de4733c5beb87a578f82a8548725305e1ff254`.
Found while running [6820](6820-agent-tools-peer-gate-linux-evidence.md)
task 2 on beelink2.

### Tasks

1. **Probe the gvisor-tap-vsock host loopback address**: the reachability check tries only slirp4netns's `10.0.2.2`, so a rootless daemon on gvisor-tap-vsock with host loopback enabled is reported `blocked`. Status: open.
2. **Word the remediation for the driver**: with host loopback off the remediation is right, but it names `10.0.2.2` as the address new containers will use. Status: open (depends on 1).

### 1. Probe the gvisor-tap-vsock host loopback address

**Problem.** On a rootless daemon whose `host-gateway` probes fail, the
reachability check tries RootlessKit's host loopback through
`ROOTLESSKIT_HOST_LOOPBACK_ADDRESS` (`10.0.2.2`) only. That is slirp4netns's
host address. Under RootlessKit's gvisor-tap-vsock driver the host loopback
address is `10.0.2.1`, so the check reports `blocked` and tells the user to
enable host loopback even when it is already enabled. Agents in new
containers then get `host.docker.internal` pointing at `host-gateway`, which
refuses, and cannot submit results, send mail or update tickets.

**Context.** Docker's `dockerd-rootless.sh` 29.9.2 chooses slirp4netns when
it is installed, then pasta, then vpnkit, and falls back to
gvisor-tap-vsock. A host without the slirp4netns package (it is a separate
package on most distributions) therefore runs gvisor-tap-vsock by default.
The probe lives in `container-host-reachability.ts` (`probeHost`,
`finishRootless`); the chosen address becomes the snapshot's `hostAddress`,
which `commands-environment.ts` writes into new containers' `--add-host` and
the firewall's host-service rule.

**Investigation.** On beelink2, 2026-11-09, with the disposable rootless
daemon (`mise run docker:disposable -- start --net gvisor-tap-vsock`; Engine
29.9.2, RootlessKit 3.3.0, builtin port driver), a busybox container called a
host listener bound to `0.0.0.0` that echoed the peer address:

| Target from the container | Host loopback on | Host loopback off |
| --- | --- | --- |
| `10.0.2.1` | Answered; peer `127.0.0.1` | Timed out |
| `10.0.2.2` | Timed out | Timed out |
| Host LAN address `192.168.4.61` | Answered; peer `192.168.4.61` | Answered; peer `192.168.4.61` |

The same daemon with host loopback on ran
`apps/backend/scripts/agent-tools-peer-evidence.ts`: every `host-gateway` and
`10.0.2.2` source failed and the host check reported `blocked`
(`output/agent-testing/s6820/rootless-gvisor-host-loopback.json`, local,
git-ignored). The `127.0.0.1` peer is admitted by the agent-tools peer gate,
so only the probe needs to change. Using the LAN address is not an option:
the gate refuses it, as it should. Neither pasta nor vpnkit was available on
this host, so their host loopback addresses were not observed.

**Decisions.**

- **How should the check find the address?**
  - **Probe `10.0.2.1` after `10.0.2.2` fails, and use whichever answers (recommended).**
    - Pros: no knowledge of the driver needed; one more probe only on a rootless daemon that already failed; the observed address and peer are known.
    - Cons: on a daemon where neither answers, the blocked verdict waits for one more probe timeout; the constant becomes a list.
  - **Read the driver from RootlessKit's API socket and probe its address.**
    - Pros: one probe, no guessing.
    - Cons: the socket is in the daemon owner's runtime directory, which a backend run as another user or against a remote `DOCKER_HOST` cannot read.
  - **Leave it and document slirp4netns as required.**
    - Pros: no code.
    - Cons: Docker's own default on a host without slirp4netns keeps being reported as broken with a fix that does not work.

### 2. Word the remediation for the driver

**Problem.** The rootless remediation says new containers will reach
Orkestrator through `10.0.2.2`. After task 1 that is wrong on
gvisor-tap-vsock.

**Context.** The text is in `buildRootlessHostRemediation` and
`finishRootless` in `container-host-reachability.ts`.

**Investigation.** Not started; it follows from task 1's choice.

**Decisions.**

- **What should the text name?**
  - **Name RootlessKit's host address without the number, and show the one in use in the reachable verdict (recommended).**
    - Pros: right for every driver; the verdict already carries `hostAddress`.
    - Cons: the remediation no longer gives the user an address to check by hand.
  - **List both addresses.**
    - Pros: complete.
    - Cons: more text in a dialog for a detail most users do not need.

## Assumptions and decisions

### Reference maintenance for tasks 1 and 2 (2026-11-10)

Replaced links to retired to-do 0109 with the living architecture or
qualification record so its deletion leaves usable references. This review
repair changes references only; the task statuses and live evidence stay as
recorded. Retaining a stub would preserve the old URLs but undo retirement.

## Related

- [6820](6820-agent-tools-peer-gate-linux-evidence.md) task 2 (the gate's rootless evidence)
- [Agent-tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts) (current rootless behavior)
- [4730](4730-disposable-docker-daemon-for-live-suites.md) (the disposable daemon used to observe this)
