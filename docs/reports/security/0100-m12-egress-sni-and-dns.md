# Narrow the egress firewall's remaining channels

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Enforce SNI or Host at the egress gateway**: the allowlist is by address, so tenants on a shared edge are reachable. Status: open.
2. **Filter DNS in the gateway**: `<data>.attacker.tld` lookups still reach a recursive resolver. Status: open.
3. **Trim the default allowlist**: some default hosts accept an attacker's credential. Status: open.
4. **Document the residual risk for users**: it is recorded for developers only. Status: open.

### 1. Enforce SNI or Host at the egress gateway

**Problem.** Domains resolve into an address set with no SNI or Host check. A default host on a shared front lets traffic reach any tenant on those addresses.

**Context.** The report recommends an SNI/Host-enforcing egress proxy. Todo 0018 records that "a plain HTTP proxy was not pursued: it does not constrain direct sockets without network enforcement beside it" (`docs/todo/containers-and-environments/0018-container-network-and-credential-isolation.md:571`). That reason no longer rules out this task, because the egress gateway now supplies the network enforcement.

**Investigation.** `docker/firewall-domains.sh` builds an `allowed-domains` set, and policy 3 stores address, protocol and port tuples (`docs/architecture/container-lifecycle.md:944-957`). No proxy ships in the image: no such package appears in `docker/Dockerfile`, and `docker/orkestrator-egress-gateway.sh` has none.

**Decisions.**

- **How to enforce?**
  - **A transparent TLS proxy in the gateway that checks ClientHello SNI against the allowlist (recommended).**
    - Pros: the workload needs no configuration; the gateway already owns the namespace; no TLS interception.
    - Cons: new software in the gateway to pin and qualify; encrypted ClientHello or domain fronting can still defeat a plain SNI check; plain HTTP on a named port needs a separate Host check.
  - **Keep address enforcement and accept the limit.**
    - Pros: no new component. `docker/init-firewall.sh:25-26` already states the limit.
    - Cons: the shared-edge channel stays.

### 2. Filter DNS in the gateway

**Problem.** Lookups for attacker-controlled names leave through Docker's resolver, which is a data channel.

**Context.** The rules keep UDP 53 from reaching arbitrary servers, but not from carrying data through the allowed resolver.

**Investigation.** `docker/init-firewall.sh:140-155` accepts DNS to the resolvers in `resolv.conf` and to Docker's upstreams. The image installs `dnsutils` (`docker/Dockerfile:103`), with no filtering resolver found. Gateway lookups for its own use go through a protected copy of the resolver list (`docker/firewall-domains.sh:49-53`), which task 2 could reuse.

**Decisions.**

- **How to filter?**
  - **A small forwarding resolver in the gateway that answers only allowlisted names (recommended).**
    - Pros: closes the tunnel; the allowlist is already there.
    - Cons: names a workload needs but the list omits start failing with a DNS error; needs its own refresh on `update-firewall.sh --set-domains`.
  - **Rate-limit or log DNS only.**
    - Pros: nothing legitimate breaks.
    - Cons: slows the channel without closing it.

### 3. Trim the default allowlist

**Problem.** Allowed APIs accept attacker credentials: `sentry.io` with an attacker's DSN, or a provider API with an attacker's key.

**Context.** Provider hosts are needed for enabled agents, and the backend only re-adds hosts for enabled platforms (`apps/backend/src/core/commands-containers.ts:428-430`). A stored user list is never widened.

**Investigation.** The list is `packages/protocol/src/network-allowlist.ts`; `sentry.io` and `statsig.com` are at `:75-77`. Nothing in the code says which defaults an agent CLI needs in order to work.

**Decisions.**

- **Which hosts can go?**
  - **Remove telemetry-only hosts (`sentry.io`, `statsig.anthropic.com`, `statsig.com`) after a live check that the agent CLIs still run (recommended).**
    - Pros: removes the easiest attacker-DSN channel; small.
    - Cons: an agent CLI might stall or log errors without them, and provider keys remain a channel in any case.
  - **Leave the list.**
    - Pros: no risk of breaking an agent.
    - Cons: the telemetry channel stays open by default.

### 4. Document the residual risk for users

**Problem.** The report asks for this to be stated prominently, and it is only written where developers look.

**Context.** Todo 0018's rule is "Never claim that IP allowlisting prevents exfiltration" (`:853`).

**Investigation.** The statement appears in `AGENTS.md:1288` and `docker/init-firewall.sh:25-26`. A search of `README.md` and `apps/web/src/components/settings` found nothing like it.

**Decisions.** None: add a sentence to the network settings help and the README, whatever tasks 1 to 3 decide.

## Current state

Narrower than when the report was written, so not in Tasks: rules live in the gateway rather than the workload, and policy 3 limits an allowed domain to TCP 443 unless an entry names a port (`docker/AGENTS.md:228-232`).

## Needs verification

- Whether each agent CLI runs without the telemetry hosts in task 3.
- Whether a SNI check and a filtering resolver work on rootless Docker and Docker Desktop.

## Related

- [Security report, M12](../2-26-10-27-security.md#m12-egress-firewall-limitations-design)
- [Todo 0018](../../todo/containers-and-environments/0018-container-network-and-credential-isolation.md): the egress gateway and its qualification
- [Container credential](../../architecture/github-cli.md#container-credential): GitHub egress as a channel for the token a container holds

## Outcome

Checked item by item on 2026-11-05 against the finished work, from base `704809a20` (branch `egress-sni-dns-6833fa71be7b-r1`). Every claim in the Investigation paragraphs still held at the base; only line numbers had moved: the DNS rules are still `docker/init-firewall.sh:140-156`, the platform re-add is now `apps/backend/src/core/commands-containers.ts:464` (S-0080, #1831, shifted it), the policy 3 sentence is `docker/AGENTS.md:245`, the root statement `AGENTS.md:1291`, and todo 0018's quoted lines are `:613` and `:897`. The recommended option was taken for every decision; how it was built is recorded in [container-lifecycle.md](../../architecture/container-lifecycle.md#name-checks-egress-filter1).

| Item | Outcome | Evidence |
| --- | --- | --- |
| Task 1: enforce SNI or Host at the egress gateway | Built (recommended option): a transparent proxy in the gateway checks the ClientHello's server name, or a plain HTTP request's Host on a named port, against the allowlist, with no TLS interception. New software: none to pin; the daemon is a repository script run by the image's existing `perl-base`. Fails closed. | `docker/orkestrator-egress-filter.pl`, `docker/init-firewall.sh`, `docker/firewall-domains.sh`; real container on Docker Desktop: an allowed name answered 200, a foreign SNI on the same address got `tlsv1 alert access denied`, a foreign Host on a named port got the gateway's 403 and never reached the fixture, and with the daemon killed an allowed address was refused (`apps/backend/tests/container-live-egress-filter.test.ts`, 4/4; [container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05)) |
| Task 1: say what it does not stop | Done | Encrypted ClientHello, domain fronting, later requests on a connection, UDP entries and other protocols: `docker/AGENTS.md`, `container-lifecycle.md`, the settings help and README; carried to [6102](../../todo/containers-and-environments/6102-egress-name-check-residual-channels.md) |
| Task 2: filter DNS in the gateway | Built (recommended option): the same daemon forwards only allowlisted names (plus GitHub's and Docker's own) through the protected resolver list and answers anything else REFUSED with Extended DNS Error 18. `update-firewall.sh --set-domains` refreshes it. A `full` container has no gateway and is unaffected. | Real container: an attacker-style name got REFUSED with EDE 18 over UDP, TCP and sent straight to an outside resolver; a name added in place resolved, one removed was refused; a full-mode runtime had no daemon and a reserved name was not refused |
| Tasks 1 and 2: a start or read never migrates; older image with this backend | Done | The gateway records `egress-filter` at its first boot; the backend reads a report without `egressFilter` as null. Live: an older image's gateway kept address-only enforcement across a restart; a gateway created with `ORKESTRATOR_EGRESS_FILTER=off` kept `off` across a restart. Unit: `apps/backend/tests/container-network.test.ts`, `apps/backend/tests/egress-gateway.test.ts`, `apps/web/src/components/environments/EnvironmentNetworkPolicyStatus.test.tsx`; register row in [version-compatibility.md](../../architecture/version-compatibility.md) |
| Tasks 1 and 2: rootless Docker and the other topology | Not done | Docker Desktop only. Rootful Linux Engine (CI's container workflow now runs the suite), rootless and Docker's addressed-upstream DNS path: [6101](../../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md) |
| Task 3: trim the default allowlist | Not done; list unchanged | No agent CLI was run without the hosts, and a provider turn was not allowed. The check, against a fake provider, and the removal: [6100](../../todo/containers-and-environments/6100-default-allowlist-telemetry-hosts.md) |
| Task 4: document the residual risk for users | Done | `ALLOWLIST_RESIDUAL_RISK` (`packages/protocol/src/network-allowlist.ts`) in Settings → Network, a container environment's Settings → Network, and the README; the environment's network status also says whether its gateway checks names. None claims exfiltration is prevented |
| Needs verification: CLIs without the telemetry hosts | Carried | [6100](../../todo/containers-and-environments/6100-default-allowlist-telemetry-hosts.md) |
| Needs verification: rootless Docker and Docker Desktop | Docker Desktop done; rootless carried | [6101](../../todo/containers-and-environments/6101-egress-name-checks-platform-coverage.md) |
| Found on the way: two live-suite cases that fail with older images too | Carried | [6103](../../todo/containers-and-environments/6103-live-suite-failures-seen-during-s0100.md) |

Docker resources this work created, all labelled `orkestrator-s0100=1` or with a suite run's private owner label, and removed afterwards: images `orkestrator-s0100:filter` and `orkestrator-s0100:iter`, network `s0100-net-manual`, containers `s0100-gw` and `s0100-wl`, and each live run's runtimes, gateways, fixtures, volumes and networks. Nothing else was pruned or removed. The existing image `orkestrator-v2:dev-01c4621f8529` was only read.
