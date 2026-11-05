## Task analysis

Analysed 2026-11-05 against main at `e1f4c875fe7667a094ab350b8f7880aab8b6783d`.

### Tasks

1. Qualify a real Tailscale-address gateway: open.
2. Qualify rootless host loopback with a positive control: open.
3. Extend the remaining Linux platform matrix: open.

### 1. Qualify a real Tailscale-address gateway

**Problem.** The Linux run used a Tailscale-address stand-in and a TCP connection to Serve, leaving the real authenticated gateway on that address untested after security report 0260 was deleted.

**Context.** The [qualification record](../../development/container-qualification.md#gateway-reach-and-project-seed-files-on-linux-engine-2026-11-05) records restricted firewall refusals before a listener, but no real gateway response at the Tailscale address. This is a remaining qualification check, not evidence of a firewall defect.

**Investigation.** Use a disposable profile with its discovered ports, bind its real gateway to the test host's Tailscale address, and compare restricted and full containers on rootful and rootless Linux. Record transport reach and the unauthenticated gateway response separately, with firewall counters and a reachable control. Do not use a production gateway or record credentials.

**Decisions.** Run the real gateway check (recommended): pros are closing the listener and authentication evidence gap; cons are needing a suitable tailnet host and disposable stack. Accept the stand-in as final evidence: pros are avoiding another live run; cons are leaving the actual gateway path unqualified.

### 2. Qualify rootless host loopback with a positive control

**Problem.** The tested rootless daemon disabled host loopback, so the run cannot establish reach or isolation for loopback-bound services when it is enabled.

**Context.** [Todo 0109](../containers-and-environments/0109-rootless-linux-runtime-gaps.md) tracks rootless host reachability. The prior named service port was unreachable in both modes and was not a positive control.

**Investigation.** On a disposable daemon configured for host loopback, compare restricted and full reach to a loopback-bound real gateway and a named service port. Confirm the named service is reachable before interpreting gateway refusals; record counters and peer addresses. Keep the shared host's Docker and firewall configuration unchanged.

**Decisions.** Use a disposable loopback-enabled daemon (recommended): pros are exercising the missing configuration without changing the shared daemon; cons are extra setup. Retain only the loopback-off qualification: pros are no setup; cons are no evidence for a supported alternative configuration.

### 3. Extend the remaining Linux platform matrix

**Problem.** Rootful full mode without a host firewall, older images with an in-container firewall, and arm64 remain outside the recorded run.

**Context.** The existing rootful full-mode probes were blocked by ufw, which the ticket required leaving enabled. The tested restricted images used an egress gateway, and the host was x86_64.

**Investigation.** Run the same restricted/full comparison on suitable disposable hosts and supported images, recording exact image capabilities, architecture, host firewall state and cleanup. For older images, distinguish runtime-root control of an in-container firewall from the egress-gateway boundary.

**Decisions.** Keep these as explicit open matrix checks (recommended): pros are preserving scope and avoiding changes to the shared firewall; cons are needing additional hosts and images. Treat the current matrix as universal: pros are no additional runs; cons are unsupported security claims.

## Assumptions and decisions

### Tasks 1–3: preserve the outstanding checks

The review fix creates this tracker without claiming new live evidence. The current restricted-container acceptance remains limited to the configurations observed. Keeping all listed Linux gaps here prevents the report deletion from losing follow-up work; Safari remains in todo 5500.

## Current state

The 2026-11-05 rootful and rootless observations stand. Rootless host loopback was off, and its named service port supplied no positive control.

## Needs verification

All three tasks require live evidence. Record results in the qualification record and update task statuses here after each run.

## Related

- [Gateway security notes](../../architecture/remote-gateway.md#security-notes)
- [Shipping Safari checks](5500-shipping-safari-gateway-security-checks.md)
- [Preview rollout](0042-service-preview-rollout.md)

## Replaces

The remaining Linux gateway qualification gaps left after security report 0260's task 3 run.
