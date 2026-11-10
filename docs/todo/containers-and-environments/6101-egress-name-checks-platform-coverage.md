## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`. Task 1 re-checked 2026-11-06
against `main` at `e6c3da899`. Task 2 acted on 2026-11-10 against `main` at
`04639b12b`, which added task 4.

### Tasks

1. **Run the live suite on rootful Linux Engine**: CI's container workflow on x64 and arm64. Status: partly done (x64 passed on beelink 2026-11-06, host daemon and a disposable rootful daemon, and two test defects fixed; arm64 has only CI's hosted-runner run and stays open).
2. **Run the live suite on rootless Docker**: a real rootless host. Status: done (2026-11-10, beelink, disposable rootless daemons from 4730: slirp4netns 6/6 and gvisor-tap-vsock 5/5; pasta is task 4).
3. **Exercise the path where Docker names its upstreams by address**: controlled addressed upstreams, forged UDP replies and TCP failover. Status: done (Docker Desktop, 2026-11-05; on rootful Linux x64 2026-11-06, where the host daemon itself names its upstream by address).
4. **Run the name checks on rootless Docker with the pasta driver**: the other RootlessKit network driver the task 2 problem names. Status: open (pasta is not installed on beelink, and installing it is a host change).

### 1. Run the live suite on rootful Linux Engine

**Problem.** Every real-container run of the name checks was on Docker Desktop 29.9.2 (Apple Silicon, LinuxKit kernel 7.0.14, iptables 1.8.11 on nf_tables). Linux Engine differs in its kernel, in how Docker's embedded resolver reaches its upstreams, and in `host.docker.internal`, which is an `/etc/hosts` alias there.

**Context.** `apps/backend/tests/container-live-egress-filter.test.ts` covers an allowed name, a foreign SNI on the same address, the HTTP Host check on a named port against a local fixture, bodies both ways, a server-first protocol, GitHub over SSH, DNS refusals over UDP, TCP and straight to an outside resolver, a live edit, the daemon killed and restarted, a restart, a full-mode runtime, the rollback switch and, with `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE`, an older image. `.github/workflows/container-live-qualification.yml` runs it on `ubuntu-24.04` and `ubuntu-24.04-arm` as "Live egress name checks (M12)", and now also triggers on the firewall scripts and the daemon.

**Investigation.** Passed 4/4 on Docker Desktop (2026-11-05, recorded in [container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05)). The CI run had not happened when this file was written.

**Result (2026-11-06, rootful Linux Engine x64).** Recorded in [container qualification](../../development/container-qualification.md#egress-name-checks-on-rootful-linux-engine-2026-11-06). On beelink (Arch, kernel 7.1.8), with image `orkestrator-q6101:e6c3da899` built from `main` at `e6c3da899`:
- The host daemon (Engine 29.9.2) has no free address pool (0241's 29 leaked probe networks), so every suite failed there in `ensureEnvironmentNetwork`. The suites ran on a disposable rootful `docker:29-dind` (Engine 29.9.3, same kernel) instead.
- `container-live-egress-filter.test.ts`, with the older image `ghcr.io/orkestrator-ai/orkestrator-v2:2.34.4-beta`: 5 pass, 0 fail, twice.
- `container-live-egress-conditions.test.ts` (IPv6 network opt-in, DNS rotation, two restarts of the disposable daemon): 3 pass, after the fixes below.
- Gateway suites: the firewall suite's policy 3 tuple case passed after its fix; network passed C24 and C26; readiness passed 8 of 9. C22 cannot pass on a nested daemon, because the backend's service port is on the outer host. C23 was not run, because it connects to `example.com`, which is off the default allowlist.
- The five cases the ticket named were also run by hand through `createDockerContainer` on the host daemon itself, with each environment network pre-created on an explicit subnet. All five passed: an allowed name answered 200; a foreign SNI on its address got `access denied`; a name off the list got `REFUSED` with EDE 18 over UDP, over TCP and to `192.0.2.53`; with the daemon killed, the allowed address was refused (curl 7) and DNS reached no server, until a refresh brought it back; and a full-mode runtime had no daemon and no record, and was not filtered. That gateway's `resolv.conf` read `# ExtServers: [172.17.0.1]`, the addressed-upstream path of task 3.
- No Linux-only defect was found. Two test defects showed on every `egress-filter=1` image, Linux included. CI run 42128741746 (Engine 28.0.4) failed both on x64 and on arm64:
  - The firewall tuple case and the DNS-rotation case sent a bare word as their first TCP write, which the name checks hold for up to 30 s. Both now send whole lines; the product behaviour is in [7000](7000-name-checks-hold-newline-less-first-writes.md).
  - The DNS-rotation case also called `node` on the gateway's root PATH ([6103](6103-live-suite-failures-seen-during-s0100.md) task 2).
- In that CI run M12 passed 4 (older image skipped), network 4/4 and readiness 9/9, on both architectures.

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

**Context.** The [rootless re-run record](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09) (from the retired to-do 0109) and [4730](4730-disposable-docker-daemon-for-live-suites.md) describe the rootless hosts and daemons the other live suites used. The gateway already works rootless for address enforcement.

**Investigation.** Not run before 2026-11-10. No rootless daemon was available on the build host. Not run on 2026-11-06 either: that run on beelink was scoped to its rootful Engine, and no rootless daemon was started.

**Result (2026-11-10, rootless Docker x64).** Recorded in [container qualification](../../development/container-qualification.md#egress-name-checks-on-rootless-docker-2026-11-10). On beelink (Arch, kernel 7.1.8), with the image `orkestrator-v2:dev-8bff8877f7f8` (`egress-filter=1`, `egress-gateway=1`, `network-policy=3`; its firewall, gateway, name-check and entrypoint scripts match `main` at `04639b12b` byte for byte), on disposable host rootless daemons started by `mise run docker:disposable` (Engine 29.9.2, RootlessKit 3.3.0 with `--detach-netns`, builtin port driver, host loopback refused, `live-restore` off):
- slirp4netns 1.3.3, with the older image `ghcr.io/orkestrator-ai/orkestrator-v2:2.34.4-beta` loaded: `container-live-egress-filter.test.ts` **6 pass, 0 fail, 124 assertions**, twice (54 s, 56 s). The same suite as task 1 plus the firewall-report case added since.
- gvisor-tap-vsock (RootlessKit's built-in driver): **5 pass, 1 skip** (the older-image case, whose image was not loaded there), 109 assertions.
- `container-live-egress-conditions.test.ts` on the slirp4netns daemon with `ORKESTRATOR_LIVE_IPV6_NETWORK=1` and the launcher's restart command: **3 pass, 66 assertions** (IPv6, DNS rotation, and two restarts of the rootless daemon through the launcher, whose restart replaces RootlessKit and its namespace as observed on 2026-11-06), with this image's name checks on.
- What the problem asked: inside RootlessKit's namespace the name-check daemon set `SO_MARK` on its own sockets while the workload, as `node` and as root, got `EPERM`; the `nat` DNATs to the gateway's own address (`172.30.1.3:31443` for TCP, `:31453` for DNS) and the `REDIRECT` of `127.0.0.11:53` all applied; and the relay recovered each connection's real destination through `SO_ORIGINAL_DST` (an allowed name answered 200 through it, a foreign SNI on its address got `access denied`, the Host check refused a request before it reached the fixture). No rootless-only defect was found.
- Docker named its upstream `# ExtServers: [host(127.0.0.53)]` on both drivers: with `--detach-netns` the daemon stays in the host's network namespace and reaches the host's stub resolver itself, so the daemon used only Docker's embedded resolver, as on Docker Desktop. The addressed-upstream path ran on rootless only through task 3's controlled-upstream case, which passed on both drivers.
- The suite now records that topology (rootless or not, the gateway's resolver lines and its nat redirections) as a JSON line, printed and appended to `ORKESTRATOR_QUALIFICATION_EVIDENCE` when set, so CI and later runs show which DNS path they took.

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

**Investigation.** The live suite now replaces a fixture gateway's protected resolver snapshot with two controlled loopback addresses. The first resolver refuses TCP or accepts without answering; the second sends invalid UDP replies, then a truncated response followed by a valid TCP answer. This passed on Docker Desktop on 2026-11-05, including UDP timeout, TCP refusal and TCP timeout failover. Forbidden names reach neither upstream. It proves the addressed-upstream selection and transport paths independently of the host's resolver configuration. On 2026-11-06 the same case passed on a disposable rootful Linux Engine. On beelink's host daemon, whose `daemon.json` sets `"dns": ["172.17.0.1"]`, a backend-created gateway's protected `resolv.conf` read `# ExtServers: [172.17.0.1]`; allowed names resolved and forbidden ones were refused through that real addressed upstream (task 1's result). On rootless (2026-11-10, task 2) the case passed on slirp4netns and gvisor-tap-vsock; there Docker named its upstream `host(127.0.0.53)`, so the real addressed path did not run on rootless.

**Decisions.**

- **How to prove it?**
  - **Record the gateway's `resolv.conf` in the CI run and check the DNS cases passed with addressed upstreams.**
    - Pros: no new test.
    - Cons: depends on the runner's resolver setup.
  - **Add a case that points the trusted `resolv.conf` at a local upstream by address (recommended).**
    - Pros: deterministic on any host.
    - Cons: a second resolver fixture to maintain.

### 4. Run the name checks on rootless Docker with the pasta driver

**Problem.** Task 2's problem names slirp4netns and pasta. The 2026-11-10 run covered slirp4netns and gvisor-tap-vsock; pasta's user-mode stack has not run the name checks.

**Context.** `mise run docker:disposable -- start --net pasta` supports it and uses RootlessKit's `implicit` port driver with it. It needs the `pasta` binary (the `passt` package) on the host.

**Investigation.** On 2026-11-10 beelink had no `pasta` or `passt` on PATH. Installing a package needs `sudo` and changes the host, which this run was not allowed to do. The name checks run inside the gateway's namespace, a Docker bridge network whatever RootlessKit uses to reach the outside, so no difference is expected; that is an expectation, not an observation. The two drivers that ran passed the same cases.

**Decisions.**

- **Is pasta needed at all?**
  - **Run it once where `passt` is installed (recommended).**
    - Pros: one `start --net pasta` and the M12 suite, about two minutes; closes the driver the problem names.
    - Cons: needs a host with `passt`, or the owner's decision to install it on beelink.
  - **Accept the two drivers that ran.**
    - Pros: no host change; the checks run inside the gateway's namespace, above the driver.
    - Cons: pasta's `implicit` port driver and its own NAT are the one path not observed.

## Assumptions and decisions

### Task 1: a disposable daemon, because the host's pools are full

Chose to run the suites on a labelled, privileged `docker:29-dind` (the
2026-10-31 recipe), rather than remove the 29 leaked probe networks or widen
the host daemon's pools. The run was allowed to remove only what it created
and could not reconfigure or restart Docker, which rules both of those out.
The nested daemon is rootful Engine on the same kernel and iptables, but its
containers' "host" is the dind container. C22 and its readiness counterpart
therefore cannot pass there, and a bind mount from a host path must also
exist inside dind; a shared `TMPDIR` solved that for C09 and C10. The five
ticket cases were repeated on the host daemon itself, with environment networks
pre-created on explicit subnets, so the name checks also have evidence from an
un-nested Engine and its real resolver configuration.

### Task 1: fix the probes, not the classifier

The two failing cases sent a bare word as their first TCP write, which the
daemon holds by design: a printable partial line could still become an HTTP
request, and relaying it early would let a request sent a byte at a time
past the Host check. Changed the tests to send whole lines, as real
line protocols do. Loosening the classifier would weaken the security
check for the sake of a test. Whether to document the behaviour, or relay
text that cannot be a method token sooner, is [7000](7000-name-checks-hold-newline-less-first-writes.md).

### Task 1: arm64 stays open

arm64 could not be run on this x64 host. CI's hosted `ubuntu-24.04-arm` run
42128741746 passed M12, network and readiness, and failed the same two test
defects as x64. Whether a hosted-runner run counts as qualification is still
the decision above, so arm64 is not ticked here.

### Task 2: disposable rootless daemons, two drivers

Followed the recommended decision: the launcher from 4730 with `DOCKER_HOST`
pointing at it, and the suites unchanged. Used an image already built on
this host (`dev-8bff8877f7f8`) rather than building one, after checking that
its capability set has `egress-filter=1` and that every script the name
checks run matches the checkout byte for byte; its `docker/` tree differs
from `main` only in the bridge launcher and a log-writer test. Ran
gvisor-tap-vsock as well as the default slirp4netns because both are built
into the launcher's tools and cost about two minutes; pasta needs a host
package and became task 4. `TMPDIR` was a directory on the home filesystem
for every run, because [7549](7549-rootless-docker-cp-refusals.md) showed
`docker cp` refusals from `nosuid,nodev` `/tmp` on rootless.

### Task 2: record the DNS topology in the suite

Added a JSON-line record of the daemon's rootless flag, the gateway's
protected resolver lines and its nat redirections to the M12 suite's first
case, printed and appended to `ORKESTRATOR_QUALIFICATION_EVIDENCE`, the
convention the rebuild-fault suite already uses. A passing logged run deletes
its output, and the run would otherwise not show whether Docker named its
upstreams by address (task 3) or through `host(...)`, which is exactly what
differed between this run and task 1's host daemon. It asserts nothing, so a
host's resolver setup cannot fail the suite.

### Task 3: controlled addressed upstreams

Chose a local two-resolver fixture in the existing opt-in live suite. This makes
failure and timeout behavior reproducible on Docker Desktop and in the existing
Linux CI job. The alternative of relying on CI's ambient resolver configuration
needs less fixture code but cannot force a failed primary or forged reply.
The fixture does not qualify a rootless or native Linux host.

## Current state

The Docker Desktop review-fix run passed the expanded name-check suite and image
smoke. On rootful Linux Engine x64 (beelink, 2026-11-06) the name-check and
conditions suites passed on a disposable daemon, and the five headline
cases passed on the host daemon. The workflow runs this suite on rootful Linux
x64 and arm64. Its firewall and conditions steps were red after S-0100 because of
the two probe defects fixed on 2026-11-06. On rootless Docker x64 (beelink,
2026-11-10) the name-check suite passed on slirp4netns and gvisor-tap-vsock
daemons, and the conditions suite, with two rootless daemon restarts, on
slirp4netns. Remaining: arm64 on a self-managed host (or the decision to
accept CI's), and rootless with pasta (task 4).

## Related

- [7420](7420-telemetry-hosts-grok-and-cursor-turns.md), [6102](6102-egress-name-check-residual-channels.md), [6103](6103-live-suite-failures-seen-during-s0100.md)
- [0018](0018-container-network-and-credential-isolation.md): the egress gateway and its qualification
- [7000](7000-name-checks-hold-newline-less-first-writes.md): a newline-less first write is held, found by task 1
- [4730](4730-disposable-docker-daemon-for-live-suites.md): the disposable daemon task 1 had to build by hand, and task 2 used
- [7549](7549-rootless-docker-cp-refusals.md): rootless `docker cp` refusals, why task 2 kept `TMPDIR` off `/tmp`
- [7390](7390-rootless-restart-remaining-settings.md): rootless daemon restarts on the other drivers (VPNKit, pasta, gvisor-tap-vsock) and with `live-restore`
- [0241](0241-leaked-reach-probe-networks.md): the leaked networks that fill the host's pools
