# VPNKit's host loopback address is never probed

## Task analysis

Analysed 2026-11-17 against `main` at `0265e7882`. Found by 6101 task 4 and
7390 (retired 2026-11-17) task 2, on beelink
([evidence](../../development/container-qualification.md#rootless-name-checks-and-restarts-on-pasta-and-vpnkit-2026-11-17)).

### Tasks

1. **Probe VPNKit's host loopback address in the reachability check**: `192.168.65.2`, so a rootless daemon on VPNKit with host loopback enabled is found `reachable`. Status: open.

### 1. Probe VPNKit's host loopback address in the reachability check

**Problem.** On a rootless daemon whose RootlessKit uses the VPNKit driver
with host loopback enabled, containers reach the host's loopback services at
`192.168.65.2`, not at `10.0.2.2`. The backend's reachability check probes
only `10.0.2.2` (slirp4netns, and pasta) and `10.0.2.1` (gvisor-tap-vsock), so
it reports `blocked` and agent tools are unavailable in containers although
the host answers. The 2026-11-04 rollout-cap run saw the same `blocked`
verdict on VPNKit with host loopback and recorded it as a path limitation.

**Context.** `ROOTLESSKIT_HOST_LOOPBACK_ADDRESSES` in
`packages/protocol/src/container-host-reachability.ts` lists the candidates;
`ContainerHostReachabilityService` probes them in order after the
`host-gateway` probes fail (`apps/backend/src/core/container-host-reachability.ts`),
and `isRootlessKitHostLoopbackAddress` lets an existing container keep an
alias naming one of them (`commands-environment.ts`). The doc comment on
`ROOTLESSKIT_HOST_LOOPBACK_ADDRESS` still says VPNKit uses `10.0.2.2`, which
is wrong. `dockerd-rootless.sh` picks slirp4netns, then pasta, then VPNKit,
then gvisor-tap-vsock, so a user gets VPNKit only on a host with neither
slirp4netns nor pasta and with `vpnkit` installed; Docker's rootless extras
no longer ship it. [Container lifecycle](../../architecture/container-lifecycle.md)
describes the check.

**Investigation.** On 2026-11-17 on beelink (disposable rootless Engine
29.9.2, RootlessKit 3.3.0 with `--detach-netns`, a static `vpnkit` reporting
commit `7f0eff0d`), VPNKit gave RootlessKit's namespace `192.168.65.3/24`
with gateway and resolver `192.168.65.1`. A host listener on
`127.0.0.1:<ephemeral>`, probed with `curl` from a container on the default
bridge and on a custom network: with `--host-loopback`, `192.168.65.2`
answered and `10.0.2.2` and `10.0.2.1` timed out; with host loopback refused
(the default), `192.168.65.2` was refused, so nothing is open by default. On
pasta with `--host-loopback`, `10.0.2.2` answered, which the check already
probes. The backend's check itself was not run against the VPNKit daemon in
that session; the `blocked` verdict follows from the candidate list and
matches the 2026-11-04 run.

**Decisions.**

- **How should the check find VPNKit's address?**
  - **Add `192.168.65.2` as a third candidate, after `10.0.2.2` and `10.0.2.1` (recommended).**
    - Pros: one constant and its tests; the check stays independent of the driver, as its comment intends (a backend run as another user or against a remote daemon cannot read RootlessKit's state); slirp4netns and gvisor-tap-vsock hosts keep their order and cost nothing until their own address fails.
    - Cons: when both earlier probes fail on another driver, a probe to `192.168.65.2` leaves through that driver's NAT to the host's network, and the check counts any HTTP response as `reachable`, so a LAN machine at that address serving HTTP on the agent tools port would be mistaken for the host. The probe should therefore require the agent tools server's own reply rather than any HTTP status for this address, or accept the risk with a note.
  - **Read the driver and probe only its address.**
    - Pros: no probe that can leave the namespace.
    - Cons: the backend would need RootlessKit's state or `docker info` to name the driver, which it does not; it breaks the driver-independent design.
  - **Document VPNKit with host loopback as unsupported.**
    - Pros: no code.
    - Cons: leaves a working setup reported as `blocked`, with a remediation (enable host loopback) the user has already applied.

## Constraints and rationale

- Orkestrator never enables host loopback itself; the probe only finds an
  address the user's daemon already opens.
- A rootless daemon with host loopback refused must stay `blocked`: refusing
  it blocks `192.168.65.2` on VPNKit, as observed.

## Needs verification

- The backend's reachability check (`check_container_host_reachability`) on a
  disposable VPNKit daemon started with `--host-loopback`, before and after the
  change, and C22 on the same daemon.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md) task 4 and 7390 (retired 2026-11-17) task 2: the runs that found it.
- [Container qualification](../../development/container-qualification.md#rollout-cap-retirement-review-qualification-2026-11-04): the 2026-11-04 VPNKit run whose host discovery reported `blocked`.
- 7548 (retired 2026-11-10): the same gap for gvisor-tap-vsock's `10.0.2.1`, closed by adding it as a candidate ([evidence](../../development/container-qualification.md#gvisor-tap-vsock-host-loopback-7548)).
