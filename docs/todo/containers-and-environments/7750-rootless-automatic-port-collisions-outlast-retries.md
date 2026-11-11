# On a busy host a rootless start can collide on four automatic ports in a row

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (branch commits up to
`6cafe7fa9`), on beelink2, while running
0049 task 9 (retired the same day; summary in
[agent-testing.md](../../development/agent-testing.md)) on a disposable
rootless daemon.

### Tasks

1. **Make a rootless container start survive a run of automatic-port collisions**: three retries (7549 task 3) were not enough twice in a row on 2026-11-11. Status: open.

### 1. Make a rootless container start survive a run of automatic-port collisions

**Problem.** Starting a container environment on a rootless daemon failed
twice in a row with `ContainerLifecycleError:port-conflict` ("A host port
this environment publishes is in use by another program"). The backend log
showed three retries each time, every one on a different automatic port:

```
[docker] start.port-collision-retrying container=b2dcdbfd3953 port=32792 retry=1
[docker] start.port-collision-retrying container=b2dcdbfd3953 port=32794 retry=2
[docker] start.port-collision-retrying container=b2dcdbfd3953 port=32800 retry=3
[docker] start.port-collision-retrying container=8b5fc80a66a0 port=32808 retry=1
[docker] start.port-collision-retrying container=8b5fc80a66a0 port=32814 retry=2
[docker] start.port-collision-retrying container=8b5fc80a66a0 port=32816 retry=3
```

The next attempt, a minute later, started at once. A user on a rootless
daemon sees an environment that will not start, with a message that names no
port they configured.

**Context.** `startDockerContainer` (`apps/backend/src/core/container-start.ts`)
retries a start whose automatic port collided `PORT_COLLISION_RETRIES` (3)
times, set by 7549 task 3 on 2026-11-10 after two consecutive collisions.
Rootless dockerd hands out automatic ports in sequence from the kernel's
ephemeral range, which on this host is `32768 60999`
(`/proc/sys/net/ipv4/ip_local_port_range`), the same range outbound sockets
take their local ports from. beelink2 runs several agents, test profiles and
browsers at once, so the low end of that range is busy with short-lived
outbound sockets. Run: disposable daemon `idle0049`
(`mise run docker:disposable -- start --name idle0049 --host-loopback`,
slirp4netns, Docker Engine 29.9.2), profile `idle0049-ctr`, the
idle-observation spec's container variant; runs `idle0049-ctr-4` and
`idle0049-ctr-5` failed this way, `idle0049-ctr-3` and `-6` started.

**Investigation.** Only the log lines above. Not checked: whether the
colliding ports were held by outbound sockets (no socket listing was taken
at the time; nothing listened on 32792 to 32816 a minute later), whether a
rootful daemon on the same host collides as often, and whether Docker can be
given a port range of its own for automatic ports.

**Decisions.**

- **How should a rootless start get past a run of collisions?**
  - **Keep retrying while each retry draws a new port, up to a bound sized for a busy host (for example 10), and log the run's length (recommended).**
    - Pros: a small change at the one place that already retries; each retry is cheap; the bound still stops a start that can never succeed.
    - Cons: picks a number from two samples; a host busier than this one could still exhaust it.
  - **Give automatic ports a range outside the kernel's ephemeral range (a daemon or per-container setting).**
    - Pros: removes the cause rather than outlasting it.
    - Cons: whether Docker 29 offers this for rootless is not established; a fixed range can itself fill up; it changes what users see as published ports.
  - **Leave it and document a retry.**
    - Pros: no code change.
    - Cons: the user has to retry by hand after a message that blames another program.

## Related

- [7549-rootless-docker-cp-refusals.md](7549-rootless-docker-cp-refusals.md)
  task 3, which raised the retries from one to three.
- 0049 task 9 (retired 2026-11-11), the run that found it; the run is
  summarised in [agent-testing.md](../../development/agent-testing.md).
