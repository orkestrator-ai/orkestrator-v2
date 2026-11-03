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
- [0070](0070-h5-host-github-token-default.md): GitHub egress as a channel
