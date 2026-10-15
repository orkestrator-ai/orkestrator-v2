# Container network and credential isolation

Checked against `main` at `2459b05c` (2026-10-15).

Restricted mode limits where a container can connect with an in-container
IPv4 ipset firewall. Root sets it up through narrow sudo grants, and the
workload needs `NET_ADMIN` to have it. The remaining work makes one default
allowlist canonical and evaluates enforcement outside the workload. Only once
restricted containers no longer need `NET_ADMIN` can the sudo grants shrink or
`no-new-privileges` be considered.

## Current state

- Firewall: `docker/init-firewall.sh` (boot, policy 3), `docker/firewall-domains.sh`
  (shared library: per-address expiry, TTL refresh, atomic `ipset swap`,
  conntrack revocation), `docker/update-firewall.sh` (`--set-domains`,
  `--add`, `--remove`, `--host-ports`, `--refresh-loop`) and
  `docker/network-policy-entrypoint.sh` (records the policy once, root-owned).
- Allowed traffic sits in one ipset, `allowed-domains`. Under policy 3 it
  holds address, protocol and port tuples (`hash:net,port`): a bare domain is
  TCP 443, `host:port` or `host:port/udp` opens exactly that port, and
  GitHub's ranges are TCP 443 and 22. Policies 1 and 2 hold addresses, open
  on every port; the backend sends their containers each entry's domain
  without its port. A domain on a shared CDN address still opens the same
  ports to every other site on it. `AGENTS.md` "Network Isolation" and
  [Container lifecycle](../architecture/container-lifecycle.md) "Port and
  protocol tuples" describe it.
- Backend: `apps/backend/src/core/container-network.ts`.
  - `ensureEnvironmentNetwork` creates one labelled bridge per environment.
  - `configuredAllowedDomains` is the saved list plus `requiredAgentNetworkDomains`;
    `containerAllowedDomains` is that list as the container's policy takes it.
  - `applyEnvironmentAllowedDomains` applies a saved list in place.
  - `environmentNetworkPolicy` reports `applied`, `pending` or
    `rebuild-required`. A mode change (restricted to full or back) is
    always `rebuild-required`.
- `NET_ADMIN`: `createDockerContainer` (`apps/backend/src/core/commands-containers.ts`)
  adds `--cap-add NET_ADMIN` to every container that is not in full mode,
  because the firewall needs it. The capability is container-wide, so a root
  terminal (`docker exec --user orkroot`) in restricted mode can change the
  firewall. `AGENTS.md` documents this as a product choice. Full-mode
  containers do not get `NET_ADMIN`.
- sudo: `docker/Dockerfile` writes `/etc/sudoers.d/node-firewall` with three
  `NOPASSWD` grants for `node`: `network-policy-entrypoint.sh *`,
  `init-firewall.sh` and `run-root-setup.sh *` (the last only acts when the
  recorded mode is `full`). `node` has no sudoers path to `orkroot`.
- Default allowlists come from four places:
  - `DEFAULT_ALLOWED_DOMAINS` in `apps/backend/src/core/storage-shared-core.ts`,
    persisted for a new install;
  - the renderer fallback `allowedDomains: [...]` in `apps/web/src/stores/configStore.ts`;
  - the firewall fallback `DOMAIN_ARRAY` in `docker/init-firewall.sh` (also
    read by `default_domains_csv` in `update-firewall.sh`), used when
    `ALLOWED_DOMAINS` is absent;
  - provider hosts in `AGENT_NETWORK_DOMAINS_BY_PLATFORM`
    (`apps/backend/src/core/constants.ts`), added by
    `requiredAgentNetworkDomains` only for enabled platforms.

  The first three differ. `tests/unit/version-drift.test.ts` requires only the
  image's own hosts (`github.com`, `registry.npmjs.org`, `cdn.playwright.dev`
  and the mise runtime hosts) to appear in all three.
- Host access: policy 2 allows the host only on the agent-tools port and
  inbound connections only on published ports, all published on
  `127.0.0.1`. `container-host-reachability.ts` (#885) probes that path and
  offers host firewall fixes.
- Credentials: staged inputs and credential syncs go only to providers that
  are enabled, authorized for agent-test profiles and not revoked
  (`providerCredentialsAllowed`, `apps/backend/src/core/portable-input-status.ts`).
  `revoke_provider_credentials` is durable and stops the provider's bridge;
  `restore_provider_credentials` allows it again. The Cursor key is not in a
  staged-inputs container's creation environment; the Anthropic key is a
  staged file there.

## Outstanding work

### Code

2. One canonical default allowlist. Generate the shell and renderer fallbacks
   from the backend list (at image build and from the protocol package), or
   have the renderer read the backend's list, rather than keeping three
   copies. `requiredAgentNetworkDomains` stays the only provider-specific
   addition. Replace the partial drift test with an equality or generation
   check. Never widen a stored user list on a read.
3. External egress prototype, kept bounded. Enforce egress outside the
   workload with no workload `NET_ADMIN`. Prove a working path for non-HTTP
   Git/SSH, provider endpoints and the agent-tools callback, then measure
   overhead and failure recovery. A plain HTTP proxy does not constrain direct
   sockets without network enforcement beside it. Only after the prototype
   replaces the privileged init can `NET_ADMIN`, the `init-firewall.sh` grant
   or `no-new-privileges` be reconsidered.
4. Optional: change mode in place (restricted to full and back) instead of
   requiring a rebuild.

### Qualification

- The Desktop and arm64 packet matrix and live credential rotation are
  tracked in [container-platform-qualification.md](container-platform-qualification.md).
  Item 3 needs live packet tests on Linux Engine and Desktop: allowed provider
  access, blocked destinations, host callbacks, sibling isolation, DNS
  rotation, IPv6 and firewall initialisation failure.
- Policy 3 (port tuples, done 2026-10-15) has unit coverage only. C22 now
  checks that an allowed domain answers on 443, another port on the same
  address is rejected and Git over SSH reaches GitHub; C23 checks per-port
  edits and revocation. Neither has run on a real daemon (Docker Desktop
  would not start containers that day), and `hash:net,port` support on the
  Desktop and rootless kernels is unconfirmed (init fails closed without
  it). The live re-run in container-platform-qualification.md covers both.

## Constraints and rationale

- Default ports (decided 2026-10-15): TCP 443 for allowed domains, TCP 443 and
  22 for GitHub's ranges. Everything on the default lists is HTTPS on 443, so
  anything else needs a `host:port` (or `host:port/udp`) entry; plain HTTP
  (80) and SSH to other Git hosts are not defaults. Lists that relied on
  another port are not rewritten; the network status and settings help say
  what applies.
- Never claim that IP allowlisting prevents exfiltration. Shared CDN
  addresses, allowed services and DNS remain channels.
- Never fall back to the shared default bridge when the environment network
  cannot be created; that is an explicit error.
- No allow-all or empty window during a refresh: build the next set beside
  the live one, swap it in, then revoke tracked connections of removed
  entries.
- IPv6 stays dropped unless equivalent IPv6 enforcement is implemented and
  tested.
- Keep the restricted-mode sudo policy exact. Never add blanket sudo, never
  mount the Docker socket, and do not remove sudo capabilities or enable
  `no-new-privileges` before the privileged firewall initialisation has
  actually been replaced.
- Do not describe a root workload as unable to change its firewall.
- Published ports stay on loopback and authenticated.
- Credentials go only to enabled, authorized, non-revoked providers.
  Revocation is recorded before anything else, so an interrupted revoke still
  gates staging and syncs. Never promise that removal retracts a credential a
  workload already read, and never revoke an account-wide key.

## Open questions

- Which external enforcement: a proxy, a per-environment gateway container on
  the environment network, or a privileged sidecar that joins the workload's
  network namespace and owns its rules (so the workload process itself lacks
  `NET_ADMIN`)?
- How far to narrow root-terminal `NET_ADMIN` in restricted mode. Today it is
  a documented product choice, and the capability cannot be removed from one
  `docker exec` while the container keeps it.

## Related

- [container-platform-qualification.md](container-platform-qualification.md),
  [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md)
  (retiring the policy-1 shared-bridge path),
  [service-preview-rollout.md](service-preview-rollout.md) (the container
  preview relay), [mcp-environment-delivery.md](mcp-environment-delivery.md)
  (network and auth for MCP outside the backend host).
- [Container lifecycle](../architecture/container-lifecycle.md): "Environment
  networks", "Agent tools reachability" and "Portable inputs".
- Living-doc drift to fix: `docker/AGENTS.md` says `node` has passwordless
  sudo for "exactly two things" (`init-firewall.sh` and `run-root-setup.sh`),
  but `docker/Dockerfile` grants three, the third being
  `network-policy-entrypoint.sh *`. The root `AGENTS.md` is correct.

## Replaces

- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (unfinished items: tuples, canonical defaults, external egress, privilege
  boundary, in-place mode change)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (credential and revocation constraints)
- `docs/improvements/containers/plan/00-index.md` (networking and privilege
  decisions)
- `docs/improvements/containers.md` (finding 5 and its egress-proxy
  recommendation)
- `docs/reviews/2026-09-15-fable-review.md` (the `NET_ADMIN` residual; its
  sudo findings are fixed)
