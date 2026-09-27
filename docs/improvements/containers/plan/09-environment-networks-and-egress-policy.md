# 09 — Environment networks and egress policy

Status: Not started. Dependencies:
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
- [ ] Resolve with bounded concurrency, query deadlines and maximum domains,
  addresses and CIDRs. Validate addresses and distinguish required-host failure
  from optional-host failure. Proposed caps must be fixed in code and tested.
- [ ] Build a new policy/set off to the side and atomically activate it. Keep
  DROP defaults during setup; no temporary allow-all window during refresh.
- [ ] Track TTL/expiry and use bounded retry/backoff. A transient refresh may
  retain the last valid set only until its documented expiry; expired required
  entries cannot silently become permanently trusted.
- [ ] Apply removals as actual revocations: consider established connections
  and conntrack state. If immediate revocation cannot be supported safely,
  stop/rebuild the affected runtime and report the effective revision accurately.
- [ ] Make edits durable and reconcile them after restart. Do not let a runtime
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
