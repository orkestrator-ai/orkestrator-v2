## Task analysis

Analysed 2026-11-05 against main at `e1f4c875fe7667a094ab350b8f7880aab8b6783d`.
Tasks 2 and 3 worked on 2026-11-09 against main at `c6de4733c5beb87a578f82a8548725305e1ff254`
(see Assumptions and decisions).

### Tasks

2. Qualify rootless host loopback with a positive control: done (2026-11-09).
3. Extend the remaining Linux platform matrix: open. A firewall-less rootful daemon (nested in a disposable rootless one) and a workload firewall (a gateway-less variant of the current image) were run on 2026-11-09. Still open here: a historical image built before the gateway. The bare-metal rootful host with no firewall and the arm64 host moved to the manual-test checklist (7568).

### 2. Qualify rootless host loopback with a positive control

**Problem.** The tested rootless daemon disabled host loopback, so the run cannot establish reach or isolation for loopback-bound services when it is enabled.

**Context.** Rootless host reachability, and why a daemon with host loopback off reports `blocked`, is in [container lifecycle](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts) (decided in todo 0109, retired on 2026-11-10); the remaining rootless reachability gap is [7548](../containers-and-environments/7548-rootless-gvisor-tap-vsock-host-loopback.md). The prior named service port was unreachable in both modes and was not a positive control.

**Investigation.** On a disposable daemon configured for host loopback, compare restricted and full reach to a loopback-bound real gateway and a named service port. Confirm the named service is reachable before interpreting gateway refusals; record counters and peer addresses. Keep the shared host's Docker and firewall configuration unchanged.

**Decisions.** Use a disposable loopback-enabled daemon (recommended): pros are exercising the missing configuration without changing the shared daemon; cons are extra setup. Retain only the loopback-off qualification: pros are no setup; cons are no evidence for a supported alternative configuration.

**Outcome (2026-11-09).** Done on beelink2 with `mise run docker:disposable -- start --host-loopback` and the live suite `apps/backend/tests/container-live-rootless-host-loopback.test.ts`. The named service port answered from every runtime (the positive control). Restricted runtimes, behind a gateway or with the firewall in the workload, were refused at once on every other loopback port, the real gateway included, and each firewall's REJECT counter rose by exactly the refused probes. Full runtimes reached every loopback-bound listener, which saw the peer as `127.0.0.1`; the real gateway still asked for a login. Results are in the [qualification record](../../development/container-qualification.md#host-loopback-rootful-reach-and-workload-firewalls-on-linux-engine-2026-11-09).

### 3. Extend the remaining Linux platform matrix

**Problem.** Older images with an in-container firewall remain outside the recorded run. (Rootful full mode on a bare-metal host without a firewall, and arm64, also remain; they need hosts the fleet lacks and are in the manual-test checklist, 7568.)

**Context.** The existing rootful full-mode probes were blocked by ufw, which the ticket required leaving enabled. The tested restricted images used an egress gateway, and the host was x86_64.

**Investigation.** Run the same restricted/full comparison with a supported image built before the gateway, on a disposable daemon, recording exact image capabilities, architecture, host firewall state and cleanup. For older images, distinguish runtime-root control of an in-container firewall from the egress-gateway boundary.

**Decisions.** Keep this as an explicit open matrix check (recommended): pros are preserving scope and avoiding changes to the shared firewall; cons are needing an older image. Treat the current matrix as universal: pros are no additional runs; cons are unsupported security claims.

**Outcome so far (2026-11-09).** Two of the three parts ran on beelink2. Details are in the [qualification record](../../development/container-qualification.md#host-loopback-rootful-reach-and-workload-firewalls-on-linux-engine-2026-11-09).

- **Workload firewall.** A variant of the current image whose manifest and label omit `egress-gateway` and `egress-filter` got its firewall in the workload with `NET_ADMIN`. It refused the same probes as the gateway runtime. Runtime root (`orkroot`) could then insert an `ACCEPT` rule and reach the gateway. The same command was refused in a gateway runtime, which stayed blocked.
- **Rootful, no host firewall.** A rootful-mode daemon nested in the disposable rootless daemon, with nothing filtering its host's `INPUT`, ran `apps/backend/tests/container-live-rootful-host-reach.test.ts`. A full runtime reached a real gateway bound to `0.0.0.0` by the host's address (401) and arrived with its own address, so the loopback-only login route answered 404. It could not reach anything bound to `127.0.0.1`. The restricted runtime reached only the named service port.

Still open, and why:

- **A historical image.** The variant shares the current firewall scripts, so it shows how the backend places and runs a workload firewall. It does not show whether an image built before the gateway (policy 1 or 2 scripts) behaves the same. That needs an older image tag, or an image built from a commit before the gateway.

The bare-metal rootful host with no firewall (beelink2's rootful daemon is out of the build user's reach and runs ufw, which must stay on) and an arm64 Linux host (emulated arm64 is not a qualification of an arm64 kernel and iptables) moved to the manual-test checklist (7568).

## Assumptions and decisions

### Tasks 1–3: preserve the outstanding checks

The review fix creates this tracker without claiming new live evidence. The current restricted-container acceptance remains limited to the configurations observed. Keeping all listed Linux gaps here prevents the report deletion from losing follow-up work; Safari remains in todo 5500.

### Task 2: a repeatable live suite, not a one-off run

Chose a live test (`container-live-rootless-host-loopback.test.ts`, opt-in through the variables `docker:disposable` prints) over a hand-run probe script, so the configuration can be requalified on any host. The real gateway is the backend's own `OrkestratorGateway` in agent-test mode, bound to `127.0.0.1` with a fixed test token, rather than a `dev:test` profile. That avoids starting an app stack with real credentials, and still tests the auth layer the profile would use. Containers are created by the backend's own create and start paths (`createDockerContainer`, `startRuntime`) after the backend's host check has picked the RootlessKit address, so the runtimes carry the production alias and firewall rules.

### Task 2: what the 421 answer means

From a full runtime, the gateway answered `host.docker.internal` with 421. Its Host check refuses multi-label names it does not know, to stop DNS rebinding. The check is not a boundary against a client that writes its own headers, and the code says so. The suite therefore also probes by the IP literal and with a forged `Host: 127.0.0.1:<port>`; both reach the auth layer and get 401. The gateway's agent-test login route, which is served only to loopback peers, answered 401 rather than 404. So the gateway took the container for a loopback peer, and minting a login code still needed the gateway token.

### Task 3: a variant image, not a historical build, for the workload firewall

The backend picks where the firewall runs from the capabilities in the image's manifest (`egressEnforcement`). A small derived image that drops `egress-gateway` and `egress-filter` from the manifest and label exercises the backend's real workload-firewall path. Building a pre-gateway commit would cost a full build. It would also test older firewall scripts the current backend no longer creates for new images. So the variant is recorded as such, and the historical image stays open.

### Task 3: a nested rootful daemon for the firewall-less case

beelink2's rootful daemon is out of reach (see task 3), and the host firewall must not change. A `docker:29-dind` container inside the disposable rootless daemon runs a rootful-mode `dockerd` (no `name=rootless` in `docker info`) with nothing filtering `INPUT`. Earlier rootful runs in this record used the same nesting. The suite runs inside that daemon's host namespace, from a host-network container with the worktree mounted read-only, so its listeners are on the daemon's host. The result is recorded as nested, and a bare-metal run stays open.

### Tasks 2–3: GitHub ranges seed for reruns

Restricted firewalls fail closed without GitHub's ranges. This host's address had spent GitHub's 60 unauthenticated API requests an hour, so gateways failed with `curl: (22) … 403`, and so did the backend's own seed fetch. Both suites accept `ORKESTRATOR_LIVE_GITHUB_RANGES_SEED`, a file in the backend's seed format fetched once from `api.github.com/meta`, copied into the run's private data directory. No credential is used. The seed only names GitHub's published ranges, so it does not widen what a container can reach.

## Current state

The 2026-11-05 rootful and rootless observations stand. On 2026-11-09 the rootless daemon with host loopback enabled was qualified with a positive control (task 2), and the workload-firewall path and a nested firewall-less rootful daemon were run (task 3). The historical-image part of task 3 remains here; task 1 and task 3's bare-metal rootful and arm64 parts need hosts the fleet lacks and moved to the manual-test checklist (7568).

## Needs verification

- Task 3's historical image. Record results in the qualification record and update the task status here after the run.

## Related

- [Gateway security notes](../../architecture/remote-gateway.md#security-notes)
- Shipping Safari checks: to-do 5500 (retired 2026-11-10); see the [gateway security notes](../../architecture/remote-gateway.md#security-notes).
- [Preview rollout](0042-service-preview-rollout.md)
- [Rootless agent tools reachability](../../architecture/container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts)
- [Rootless gvisor-tap-vsock host loopback](../containers-and-environments/7548-rootless-gvisor-tap-vsock-host-loopback.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the bare-metal rootful and arm64 parts of task 3) moved there on 2026-11-10.

## Replaces

The remaining Linux gateway qualification gaps left after security report 0260's task 3 run.
