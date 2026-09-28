# 09 — Environment networks and egress policy

Status: Implemented on branch; awaiting review. Dependencies:
[02](02-lifecycle-authority-and-durable-operations.md),
[03](03-image-contracts-and-daemon-preflight.md),
[04](04-runtime-readiness-and-graceful-shutdown.md).
Return to [index](00-index.md).

## Goal and policy boundary

Separate environment network membership, replace the guessed gateway `/24`
exception with explicit service access, and make restricted mode's effective
IPv4/IPv6 policy observable and tested. The initial implementation still uses
an in-container firewall. It limits destinations; it does not prevent all data
transfer through allowed services or isolate code that the user runs as root.

## Integration points

- [Container specification](../../../../apps/backend/src/core/commands-containers.ts),
  [host callback routing](../../../../apps/backend/src/core/commands-environment.ts),
  [platform alias helper](../../../../apps/backend/src/core/commands-container-exec.ts).
- [Firewall init](../../../../docker/init-firewall.sh),
  [firewall updates](../../../../docker/update-firewall.sh),
  [root setup policy](../../../../docker/run-root-setup.sh).
- [Environment domain commands](../../../../apps/backend/src/core/commands-registry-environments.ts),
  [backend defaults](../../../../apps/backend/src/core/storage-shared-core.ts),
  [frontend defaults](../../../../apps/web/src/stores/configStore.ts).
- [Firewall tests](../../../../tests/unit/firewall-policy.test.ts) and
  [version drift tests](../../../../tests/unit/version-drift.test.ts).

## Proposed effective-policy record

Store configured domains/mode separately from the effective applied revision.
Include network identity, approved service destinations/ports, DNS resolver
identities, IPv6 policy, resolution timestamp/expiry and bounded failure codes.
Do not serialize all rules or provider request traffic to the renderer.

Network ownership is per environment and independent of UI visibility. A
replacement may reuse its verified environment network, but source and
candidate workloads must not both run. Sidecars, if supported later, need
explicit environment membership; this step does not introduce a sidecar UI.

## Implementation tasks

### Network ownership and host access

- [ ] Create one labeled user-defined bridge per environment, with an operation
  record before creation. Inspect/adopt exact identity after ambiguous create.
- [ ] Specify that network in every capable container create; never silently
  fall back to the shared default bridge when creation/attachment fails.
- [ ] Discover actual gateway/subnet/DNS values from Docker. Remove the `/24`
  inference from both policy generation and diagnostics.
- [ ] Enumerate required backend callback destinations and exact ports from
  configured agent-tool connections. Permit only those service paths plus
  required established response traffic, preserving Linux/Desktop differences.
- [ ] Keep all published agent/preview ports bound to loopback and authenticated
  where applicable. Test host-to-container ingress through published ports;
  dropping broad host ingress must not break legitimate connection establishment.
- [ ] Test sibling access via container IP, bridge gateway and host-published
  ports. A separate network alone is not enough if the host exception still
  reaches every sibling's mapped port.
- [ ] Account for finite Docker address pools and network counts. A capacity
  failure is explicit and non-destructive; cleanup removes only unused owned
  networks after reference checks, never foreign networks.

### Policy generation and updates

- [ ] Centralize canonical product defaults and provider-required domains, then
  generate shell/UI fallbacks. Preserve per-environment overrides and enabled
  provider scope; do not widen a stored user list on a read.
- [ ] Represent allowed traffic as address/protocol/port tuples where possible.
  Preserve intended Git/SSH access explicitly rather than assuming all domains
  require all ports. Document GitHub ranges and shared-IP limitations.
- [ ] Choose explicit IPv6 behavior for the initial release: disable external
  IPv6 on managed restricted networks unless equivalent IPv6 enforcement is
  implemented and tested. Verify actual behavior, not just a config flag.
- [x] Resolve with bounded concurrency, query deadlines and maximum domains,
  addresses and CIDRs. Validate addresses and distinguish required-host failure
  from optional-host failure. Proposed caps must be fixed in code and tested.
- [x] Build a new policy/set off to the side and atomically activate it. Keep
  DROP defaults during setup; no temporary allow-all window during refresh.
- [x] Track TTL/expiry and use bounded retry/backoff. A transient refresh may
  retain the last valid set only until its documented expiry; expired required
  entries cannot silently become permanently trusted.
- [x] Apply removals as actual revocations: consider established connections
  and conntrack state. If immediate revocation cannot be supported safely,
  stop/rebuild the affected runtime and report the effective revision accurately.
- [x] Make edits durable and reconcile them after restart. Do not let a runtime
  allowlist edit revert invisibly to old container environment variables.
- [ ] Correct AGENTS.md's blanket SSH claim and document the actual threat model.

### Privilege boundary and optional follow-up

- [ ] Keep `NET_ADMIN`/sudo only where the current firewall implementation
  requires it. Full-mode/root-terminal capabilities remain explicit product
  choices; do not describe root workloads as unable to change their firewall.
- [ ] Evaluate external egress enforcement in a separate bounded prototype:
  proxy/gateway outside the workload, no workload `NET_ADMIN`, and a tested
  path for non-HTTP Git/SSH and provider callbacks. Measure overhead and failure
  recovery before selecting it. A normal HTTP proxy alone does not constrain
  arbitrary direct sockets without network enforcement.
- [ ] Do not enable `no-new-privileges` or remove sudo capabilities until the
  privileged initialization path has actually been replaced.

## Verification and exit criteria

Real packet tests are required on Linux Engine and Docker Desktop, amd64 and
arm64 where available. Cover provider endpoints, package installs, Git fetch,
SSH when allowed, preview ingress, host tools, sibling direct/host-mediated
access, rogue DNS targets, IPv6, DNS rotation, refresh expiry, mode changes and
missing GitHub metadata. Verify failed policy application never reports ready.

Inject network creation/attachment failure and backend restart during policy
update. Restart/rebuild must preserve the configured and effective distinction.
Exit when current managed networks have a tested narrow policy and cleanup
cannot remove a network still referenced by an operation. External egress
enforcement may remain explicitly deferred with its prototype results.

## Implementation record

- **Image.** `init-firewall.sh` declares `network-policy=2`: host services by
  exact port on the gateway and `host.docker.internal` addresses (no `/24`),
  ingress only to published ports, IPv6 dropped (fail if configured without
  `ip6tables`), DNS to the embedded resolver's `ExtServers`, fixed resolution
  bounds, and a `/run/orkestrator/firewall.json` report written on success,
  failure and full mode. `network-policy-entrypoint.sh` captures the policy
  version and validated port lists once, root-owned; sudoers keeps exactly
  those variables. `update-firewall.sh --host-ports` replaces the host chain
  atomically and durably.
- **Backend.** `container-network.ts`: per-environment labelled network
  (exact-label adoption, ambiguous-create resolution, pool exhaustion as
  `resource-exhausted`, removal only when unattached), ingress port derivation,
  effective policy report. `createDockerContainer` attaches capable runtimes
  with IPv6 disabled and the policy inputs (opt-out
  `ORKESTRATOR_NETWORK_POLICY=1`); the agent-tools server exposes its port and
  `resolveContainerAgentToolConnection` reconciles it. The deletion ledger has a
  `network` step; reviewed cleanup lists networks; deletion now also runs the
  container step for recovery copies when there is no current runtime.
- **UI.** The network section shows what the container applied next to what is
  configured, including failure, legacy shared-network containers and a saved
  mode that awaits a rebuild.
- **Docs.** AGENTS.md no longer claims a blanket SSH or host-network exception;
  it states the policy versions and threat model.
- **Tests.** `tests/unit/firewall-policy.test.ts` (policy-2 rules, no `/24`,
  IPv6 drop, status report, bootstrap validation, sudoers scope, atomic
  replacement order); cleanup entry now schedules the network. Live (Engine
  29.7.2, `container-live-network.test.ts`): C22 — own labelled network, IPv6
  disabled, applied restricted policy reported; the service port leaves the
  container while every other host port and a sibling's service are rejected
  by the container firewall; example.com blocked; host-to-container ingress
  through a published port works; a host-port change is applied atomically,
  written durably and survives a container restart; the network is kept while
  attached and removed afterwards.
- **Refresh, edits and revocation (`network-refresh=1`).** A shared root
  library (`docker/firewall-domains.sh`) builds the allowlist for the boot and
  every change: resolved addresses carry a six-hour kernel timeout from the
  last answer that contained them; a root refresher in its own session
  re-resolves on the shortest TTL (5–30 minutes, backoff from one minute
  while a domain fails); a domain keeps its earlier unexpired addresses, so a
  rotating CDN answer does not drop open connections, and an unresolvable one
  keeps them only until expiry. Every change builds the next set beside the
  live one and swaps it in, then deletes the conntrack entries of removed
  entries. `update-firewall.sh --set-domains` applies and then stores the
  list, so it survives a restart; `--add`/`--remove` use the same path.
  Firewall state moved to root-only `/run/orkestrator-firewall/` (node owns
  `/run/orkestrator`). The backend reports the configured and enforced list
  revisions (`applied`/`pending`/`rebuild-required`), applies a saved list in
  place on save and at start, and the Network section offers "Apply now".
  Tests: `tests/unit/firewall-refresh.test.ts` (swap order, revocation, carry
  until expiry, rotation, durable edits, refused input, defaults, root-only
  paths), `container-network.test.ts` (revision parity, in-place apply,
  legacy and stopped containers). Live C23
  (`container-live-firewall.test.ts`): pending then applied in place, an open
  keep-alive connection survives an edit that keeps its domain and is cut by
  one that removes it, one unkillable refresher that a node re-run of the
  firewall does not duplicate, refused input, the applied list survives a
  restart, and a list saved while stopped is pending until applied.
- **Limitations.** On the qualification host, ufw drops container-to-host
  traffic on every Docker network, so the service port was verified to leave
  the container rather than to be answered. Docker Desktop and arm64 were not
  available. Mode changes (restricted ↔ full) still apply through a rebuild.
  External egress enforcement (proxy/gateway outside the workload) remains
  deferred.

## Audit follow-up (2026-09-27)

An item-by-item audit of this step's checklist against the code found gaps
the record above did not state. They were closed and are tracked with their
evidence in [remaining-work.md](../remaining-work.md) (items 1, 2, 6, 14, 27, 28, 39);
what could not be done on this host is listed there as environment-limited.

