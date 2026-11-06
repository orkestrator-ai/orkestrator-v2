## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`.

### Tasks

1. **Run the live suite on rootful Linux Engine**: CI's container workflow on x64 and arm64. Status: open.
2. **Run the live suite on rootless Docker**: a real rootless host. Status: open.
3. **Exercise the path where Docker names its upstreams by address**: controlled addressed upstreams, forged UDP replies and TCP failover. Status: done (Docker Desktop, 2026-11-05; native Linux qualification remains task 1).

### 1. Run the live suite on rootful Linux Engine

**Problem.** Every real-container run of the name checks was on Docker Desktop 29.9.2 (Apple Silicon, LinuxKit kernel 7.0.14, iptables 1.8.11 on nf_tables). Linux Engine differs in its kernel, in how Docker's embedded resolver reaches its upstreams, and in `host.docker.internal`, which is an `/etc/hosts` alias there.

**Context.** `apps/backend/tests/container-live-egress-filter.test.ts` covers an allowed name, a foreign SNI on the same address, the HTTP Host check on a named port against a local fixture, bodies both ways, a server-first protocol, GitHub over SSH, DNS refusals over UDP, TCP and straight to an outside resolver, a live edit, the daemon killed and restarted, a restart, a full-mode runtime, the rollback switch and, with `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE`, an older image. `.github/workflows/container-live-qualification.yml` runs it on `ubuntu-24.04` and `ubuntu-24.04-arm` as "Live egress name checks (M12)", and now also triggers on the firewall scripts and the daemon.

**Investigation.** Passed 4/4 on Docker Desktop (2026-11-05, recorded in [container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05)). The CI run had not happened when this file was written.

**Decisions.**

- **Is CI enough for rootful Linux?**
  - **Yes: the PR's workflow run on both architectures (recommended).**
    - Pros: already wired; both architectures; no host to borrow.
    - Cons: GitHub's runners are one Engine version with its default DNS setup.
  - **Also a run on a LAN Linux host (beelink).**
    - Pros: a resolver setup that is not GitHub's.
    - Cons: a borrowed host and a hand-built image.

### 2. Run the live suite on rootless Docker

**Problem.** Rootless Docker puts the container network inside RootlessKit's namespace (slirp4netns or pasta). Whether `SO_MARK`, the `nat` DNAT to the namespace's own address and `SO_ORIGINAL_DST` behave the same there is unproven.

**Context.** [0109](0109-rootless-linux-runtime-gaps.md) and [4730](4730-disposable-docker-daemon-for-live-suites.md) describe the rootless hosts and daemons the other live suites used. The gateway already works rootless for address enforcement.

**Investigation.** Not run. No rootless daemon was available on the build host.

**Decisions.**

- **Where to run it?**
  - **A disposable rootless daemon from 4730, with `DOCKER_HOST` pointing at it (recommended).**
    - Pros: no effect on any shared daemon; the same suite unchanged.
    - Cons: depends on 4730's launcher.
  - **The rootless host 0109 used.**
    - Pros: a real user setup.
    - Cons: shared with other work.

### 3. Exercise the path where Docker names its upstreams by address

**Problem.** When `resolv.conf` names Docker's upstreams by address (`# ExtServers: [8.8.8.8]`), the embedded resolver relays from inside the namespace. The daemon then sends a query that was sent off-host to those upstreams itself, and Docker's own relay is redirected back to it. On Docker Desktop the upstreams are `host(...)`, so this path never ran live.

**Context.** `query_resolvers` and `load_resolvers` in `docker/orkestrator-egress-filter.pl`; `tests/unit/egress-filter-daemon.test.ts` covers the selection.

**Investigation.** The live suite now replaces a fixture gateway's protected resolver snapshot with two controlled loopback addresses. The first resolver refuses TCP or accepts without answering; the second sends invalid UDP replies, then a truncated response followed by a valid TCP answer. This passed on Docker Desktop on 2026-11-05, including UDP timeout, TCP refusal and TCP timeout failover. Forbidden names reach neither upstream. It proves the addressed-upstream selection and transport paths independently of the host's resolver configuration. Native Linux and rootless results remain tasks 1 and 2.

**Decisions.**

- **How to prove it?**
  - **Record the gateway's `resolv.conf` in the CI run and check the DNS cases passed with addressed upstreams.**
    - Pros: no new test.
    - Cons: depends on the runner's resolver setup.
  - **Add a case that points the trusted `resolv.conf` at a local upstream by address (recommended).**
    - Pros: deterministic on any host.
    - Cons: a second resolver fixture to maintain.

## Assumptions and decisions

### Task 3: controlled addressed upstreams

Chose a local two-resolver fixture in the existing opt-in live suite. This makes
failure and timeout behavior reproducible on Docker Desktop and in the existing
Linux CI job. The alternative of relying on CI's ambient resolver configuration
needs less fixture code but cannot force a failed primary or forged reply.
The fixture does not qualify a rootless or native Linux host.

## Current state

The Docker Desktop review-fix run passed the expanded name-check suite and image
smoke. Native rootful Linux and rootless Docker are not available through this
host's selected Docker Desktop daemon; those platform claims remain open.
The existing workflow runs this suite on rootful Linux x64 and arm64.

## Related

- [6100](6100-default-allowlist-telemetry-hosts.md), [6102](6102-egress-name-check-residual-channels.md), [6103](6103-live-suite-failures-seen-during-s0100.md)
- [0018](0018-container-network-and-credential-isolation.md): the egress gateway and its qualification
