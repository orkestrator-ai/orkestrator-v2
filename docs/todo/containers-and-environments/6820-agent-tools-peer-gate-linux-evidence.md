# Prove the agent-tools peer gate on Linux Engine, rootless and other topologies

## Task analysis

Analysed 2026-11-06 against main at `66f7b743eabd03603c43a401d4afec8291dc60a8`; tasks 1, 2 and 5 acted on 2026-11-09 against main at `c6de4733c5beb87a578f82a8548725305e1ff254`.

### Tasks

1. **Run the evidence script on Linux Engine**: the topology where the subnets matter. Status: open (depends on a rootful daemon this build can reach: [4730](4730-disposable-docker-daemon-for-live-suites.md)'s nested rootful mode, or access to a host daemon).
2. **Run it on rootless Docker with host loopback**: the peer is expected to be loopback. Status: done 2026-11-09 (the peer is `127.0.0.1`; no new code needed).
3. **Run the C22 live qualification case on Linux CI**: its filter now follows the scene's owner. Status: open.
4. **Check Docker Desktop on Linux and Windows**: expected to match macOS. Status: open.
5. **Decide whether the host firewall question still matters**: the report's second verification item. Status: done 2026-11-09 (closed: the gate answers it without a firewall).

### 1. Run the evidence script on Linux Engine

**Problem.** On Linux Engine a container's call to `host.docker.internal` (Docker's `host-gateway`, the default bridge's gateway) arrives from the container's own address on its network, so admission rests entirely on the subnet list. That path has unit tests and a test that admits the host's own interface address through a `/32` subnet, but no real container has called the server through it.

**Context.** `apps/backend/scripts/agent-tools-peer-evidence.ts` runs the production `AgentToolsServer`, its default Docker-backed filter, `ensureEnvironmentNetwork`, `removeEnvironmentNetwork` and `ContainerHostReachabilityService` against a throwaway data directory and an ephemeral port, and prints JSON: the peer address the server saw for a container on an environment network, on the default bridge and on an unowned network; the reachability probe from inside the environment container and the throwaway-container host check; requests from the host to its own non-loopback addresses; and the admitted subnets before and after the network is removed. Everything it creates carries `orkestrator-s0170-evidence=1` and a throwaway owner label and is removed by it; it pulls nothing, so pull the pinned busybox (`CONTAINER_HOST_PROBE_IMAGE`) first.

**Investigation.** Run twice on 2026-11-05 on Docker Desktop 4.98.0 (Engine 29.9.2, linux/arm64, macOS host): all three containers were seen as `127.0.0.1` and got `HTTP/1.1 405`; the environment-container probe and both host-check probes (`--platform-linux`) were `reachable`/405; requests to the host's LAN (`192.168.4.51`) and tailnet (`100.81.128.8`) addresses were closed with no bytes; the admitted list was `172.17.0.0/16` and the environment network's `172.25.0.0/16`, then `172.17.0.0/16` alone after removal; nothing was left behind. Not run on Linux Engine: no Linux host was available to this build. Expected there: the environment-network and default-bridge containers admitted from their own addresses, the unowned-network container closed with no bytes, and the host's interface addresses closed. A host firewall that drops Docker traffic (ufw) makes every probe time out regardless; that is the existing reachability banner, not this gate.

**Decisions.**

- **Where to run it?**
  - **On a Linux Engine host such as beelink or omarchy-hp, once, recording the JSON here (recommended).**
    - Pros: the one topology where the gate decides on subnets; a single command.
    - Cons: needs a free Docker address pool on that host (see [0241](0241-leaked-reach-probe-networks.md) and [3320](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md)).
  - **Add it to the "Container live qualification" workflow.**
    - Pros: repeats on every relevant PR on both architectures.
    - Cons: a new live case in a workflow that is already not a required check; task 3 already covers the path the backend uses.

**Result (2026-11-09).** Not run; still open. The build ran on beelink2
(Linux 7.2.15, x86_64), but this account cannot reach the host daemon:
`/var/run/docker.sock` is `root:docker` mode `0660`, the `docker` group has no
members, and `docker.service` is inactive behind its socket unit, so every
call (the qualification shim included) answers `permission denied`. Starting,
reconfiguring or joining that daemon was out of scope. The disposable daemon
already on main ([4730](4730-disposable-docker-daemon-for-live-suites.md)
task 1) is rootless only, and on a rootless daemon the filter grants no
subnets, so a run there is not Linux Engine evidence. What remains: run
`mise exec -- bun apps/backend/scripts/agent-tools-peer-evidence.ts` once
against a rootful Linux daemon whose bridges live in the script's own network
namespace, which is either a host Engine the account may use or 4730's nested
rootful mode (`docker:29-dind`, still being built) with the script run inside
that namespace; then fill in the Linux Engine row of
[Who may connect](../../architecture/container-lifecycle.md#who-may-connect).

### 2. Run it on rootless Docker with host loopback

**Problem.** A rootless daemon reaches the host through RootlessKit's host loopback (`10.0.2.2`, [0109](0109-rootless-linux-runtime-gaps.md)). The peer address the server then sees has not been observed.

**Context.** slirp4netns (and pasta) connect to the host from a process in the host's network namespace, so the peer should be `127.0.0.1`, which the gate admits without reading Docker. If it is instead an address in RootlessKit's namespace, the gate refuses it, because no Docker network of the rootless daemon is visible from the host's namespace in that form.

**Investigation.** Not run: no rootless daemon was available on this macOS host. On a rootless host, run the script without `--platform-linux` (it is already Linux) and read `containerSources`, whose containers use `host-gateway`; if those fail, add a container with `--add-host host.docker.internal:10.0.2.2`, as the backend does once its check finds host loopback working.

**Decisions.**

- **What if the peer is not loopback?**
  - **Admit the RootlessKit peer explicitly, keyed on `dockerRootless` (recommended if it happens).**
    - Pros: keeps rootless working; narrow.
    - Cons: one more topology branch in the filter.
  - **Leave rootless refused and say so in the reachability verdict.**
    - Pros: no new code.
    - Cons: breaks agent tools on rootless hosts that work today.

**Result (2026-11-09).** Done on a disposable rootless daemon on beelink2:
`mise run docker:disposable -- start --name s6820-loop --host-loopback`
(Engine 29.9.2 linux/amd64, RootlessKit 3.3.0, slirp4netns 1.3.3, pool
`172.30.0.0/16`), the pinned busybox pulled into it, and the evidence script
run with that `DOCKER_HOST` and the qualification shim first on `PATH`. The
script now reads Docker info's security options and, on a rootless daemon,
runs the three sources a second time with `host.docker.internal` naming
`10.0.2.2` (`rootlessHostLoopbackSources`), as the backend does after its
check. Observed:

- `dockerRootless: true`.
- `containerSources` (`host-gateway`): all three containers
  (`172.30.1.2`, `172.30.0.2`, `172.30.2.2`) got `can't connect to remote host
  (172.30.0.1): Connection refused`; the server saw no peer.
- `rootlessHostLoopbackSources` (`10.0.2.2`): environment network, default
  bridge and unowned network all arrived as **`127.0.0.1 (admit)`** and got
  `HTTP/1.1 405 Method Not Allowed`.
- Environment-container probe: `refused` through `host-gateway`,
  `reachable`/405 through `10.0.2.2`. Host check: `reachable`,
  `dockerRootless: true`, `hostAddress: 10.0.2.2`; its two `host-gateway`
  probes `refused`, its two `10.0.2.2` probes `reachable`/405.
- The host's LAN (`192.168.4.61`) and tailnet (`100.64.228.48`) addresses:
  closed with no bytes, refused by the gate. Loopback: 405.
- Admitted subnets `[]` before and after the environment network was
  removed (`removal: removed`); unresolved cleanup and every leftover list
  empty. The daemon was then stopped and removed.

The peer is loopback, so the recommended branch above is not needed: the
filter stays loopback-only on rootless and no RootlessKit address is
admitted. A second run of the final script on a fresh daemon
(`s6820-final`) gave the same result field for field, exit status 0. Local
evidence (git-ignored):
`output/agent-testing/s6820/rootless-slirp4netns-host-loopback.json` and
`rootless-slirp4netns-host-loopback-final.json` beside it.

A second run on the same launcher with `--net gvisor-tap-vsock
--host-loopback` saw `10.0.2.2` answer `Host is unreachable` from every
container and the host check report `blocked`; no peer reached the server, so
the gate decided nothing there (evidence:
`output/agent-testing/s6820/rootless-gvisor-host-loopback.json`). A direct
check on that driver, a busybox container calling a plain host listener,
found its host loopback at `10.0.2.1`, seen by the host as `127.0.0.1` with
host loopback on and timing out with it off; `10.0.2.2` timed out either
way. So the gate would admit that driver's peer too, but the backend never
probes `10.0.2.1`: [7548](7548-rootless-gvisor-tap-vsock-host-loopback.md).

### 3. Run the C22 live qualification case on Linux CI

**Problem.** `container-live-readiness.test.ts` case C22 runs the real server from a data directory that differs from the one owning its environment network. It now passes `dockerPeerFilter(() => scene.owner)`; without that it would be refused on Linux Engine. It has not run since.

**Context.** The case runs in the "Container live qualification" workflow on linux-x64 and linux-arm64, which is not a required check ([AGENTS.md](../../../AGENTS.md#choosing-validation-for-a-change)).

**Investigation.** Typechecked only; the live suite was not run here.

**Decisions.**

- **How to confirm it?**
  - **Read the PR's run of the workflow; a red C22 is a regression of this change (recommended).**
    - Pros: no extra work; both architectures.
    - Cons: depends on the workflow being triggered by the PR's paths.
  - **Run the case by hand on a Linux host.**
    - Pros: independent of CI.
    - Cons: needs a qualification image built on that host.

### 4. Check Docker Desktop on Linux and Windows

**Problem.** Only Docker Desktop for macOS was observed. Docker Desktop on Linux and on Windows (WSL 2) forward `host.docker.internal` through their own VM networking, and the peer the host process sees has not been recorded there.

**Context.** On macOS it is `127.0.0.1`. Windows is not a supported backend host today; Docker Desktop on Linux is.

**Investigation.** Not run.

**Decisions.**

- **Is a run needed?**
  - **Run the script once on Docker Desktop for Linux when a host has it; skip Windows until it is a supported host (recommended).**
    - Pros: covers the supported case.
    - Cons: another manual run.
  - **Assume it matches macOS.**
    - Pros: none needed.
    - Cons: a wrong assumption breaks agent tools for every container there.

### 5. Decide whether the host firewall question still matters

**Problem.** The report asked whether a host firewall already hides this port on typical hosts.

**Context.** The gate now closes outside connections itself, so a firewall is no longer needed for that; the port still accepts and then closes a TCP connection, so a LAN scan sees it open for an instant.

**Investigation.** Not measured. ufw's default drop policy is documented only as something that breaks containers (the reachability check's remediation).

**Decisions.**

- **What to do?**
  - **Close the question: the gate answers it without depending on a firewall (recommended).**
    - Pros: no host survey needed.
    - Cons: the instant open-then-close stays visible to a port scan.
  - **Also bind per-gateway listeners so nothing on the LAN accepts at all.**
    - Pros: invisible to a scan.
    - Cons: the report's rejected option: listeners follow networks, and ports must be free on each.

**Result (2026-11-09).** Closed with the recommended option. The question was
whether a typical host's firewall already hides the port; the gate now makes
the answer irrelevant. On beelink2 the reachability check found ufw enabled
with a default incoming policy of DROP, and the gate still refused the host's
own LAN and tailnet addresses itself (closed, no bytes) in both task 2 runs,
which is the behaviour a host without a firewall gets. The residual exposure
(a port scan sees the handshake complete before the close) is accepted and
written into
[Who may connect](../../architecture/container-lifecycle.md#who-may-connect),
together with why per-gateway listeners stay rejected. No host survey or code
change follows.

## Assumptions and decisions

### Tasks 1, 2 and 4: topology-aware admission repair (2026-11-06)

The review identified that Desktop VM subnets could overlap host LAN/VPN
addresses. Non-Linux hosts now use loopback only. On Linux each production
refresh checks the daemon's operating system; Desktop returns no permitted
subnets, while native Engine retains the owner-labelled/default-bridge list.
Malformed or unavailable topology clears previous permissions. Tests exercise
Desktop overlap refusal, loopback admission, native Engine membership, a
native-to-Desktop transition, and topology failure revocation. This closes the
Desktop overlap defect; it does not establish live Linux or rootless peers.

A live rerun on Desktop for macOS passed explicit assertions: all three
container sources arrived as loopback and received 405; the environment probe
and host check were reachable; LAN and tailnet peers received no bytes;
permitted subnets were empty; no created resources remained. Local evidence:
`output/agent-testing/s0170-address/desktop-peer-evidence.json` (git-ignored).
The assertion wrapper initially tried parsing diagnostic logs as JSON; it was
corrected to parse the final evidence document, and the same check passed.

Live tasks 1–4 remain open: this repair session again observed `uname -s` as
`Darwin` and only default/Desktop Unix-socket Docker contexts. No native Linux
or rootless daemon is available. No synthetic topology test or Desktop VM run
is counted as native Linux evidence.

### Tasks 1 and 2: retain live topology checks as open work

The review-fix session on 2026-11-06 confirmed `uname -s` is `Darwin` and
`docker context ls` lists only the default socket and Docker Desktop's
`desktop-linux` context. No native Linux or rootless daemon was available in
this environment. The Desktop VM does not establish how a host backend sees
peers on either topology, so neither task is marked done. The script and C22
remain the required live checks; fake-clock and Docker-command tests establish
refresh timing and failure handling only.

### Tasks 1–4: round 4 cleanup, listener and rootless repair (2026-11-06)

The evidence script now selects an allowed high port before listening, retries
occupied candidates without using port zero, and retains failed cleanup IDs
until removal succeeds. Cleanup attempts all containers before networks, retries
failed container removals during finalization, and reports unresolved resources
with a failing exit status. Deterministic fault-injection tests cover the first
of three container removals failing, finalizer retry, network cleanup, permanent
failures, reserved candidates, bounded attempts and occupied ports.

Rootless daemons now grant no subnet permissions, detected from Docker info's
`SecurityOptions`. Tests cover overlapping LAN addresses, loopback, rootful to
rootless transition, restoration to rootful and malformed security options.
The implemented choice is loopback only rather than excluding host-interface
overlaps: it does not trust any namespace-local range as a host peer identity.
A non-loopback rootless peer remains refused until live evidence supports a
narrow explicit permission; task 2 remains open.

This session observed `uname -s` = `Darwin` and only `default` and
`desktop-linux` Docker contexts using local sockets. Live Linux Engine,
RootlessKit, Linux C22 and Desktop for Linux cannot be exercised here. Tasks
1–4 remain open; Windows remains unsupported. Synthetic tests do not close
these live coverage gaps. The validated deletion commit remains in history;
review repairs are subsequent commits, as required by the repair stage.

The repaired script also passed a live Desktop rerun on port 52388: all three
container sources arrived as `127.0.0.1` with HTTP 405; the environment probe
and both host-check probes returned reachable/405; LAN and tailnet calls
closed without bytes; subnet permissions were empty; unresolved cleanup and
all leftover lists were empty. Evidence is in
`output/agent-testing/s0170-address-r4/desktop-peer-evidence.json` (git-ignored).
This run does not establish the outstanding Linux topologies.

### Task 2: what the evidence script measures on rootless (2026-11-09)

The script's original `containerSources` use `host-gateway`, which on a
rootless daemon names RootlessKit's own bridge, so they can only show a
refusal. The task asked for a `10.0.2.2` container when those fail. The
script now detects a rootless daemon from Docker info's `SecurityOptions`,
using the same `ROOTLESS_SECURITY_OPTION` pattern the production filter uses
(exported from `agent-tools-peer-filter.ts`), and repeats the three sources
and the environment-container probe through `10.0.2.2`. It also reports the
host check's `hostAddress` and each probe's target. Alternative considered:
a manual `docker run --add-host host.docker.internal:10.0.2.2` beside the
script. It would not record what the server saw, which is the point of the
task. `tests/agent-tools-peer-evidence.test.ts` covers the detection.

### Task 2: no RootlessKit permission (2026-11-09)

The recommended decision was conditional on a non-loopback peer. The peer was
`127.0.0.1` for every source, so the filter keeps granting no subnets on
rootless. Adding a permission anyway would admit addresses in RootlessKit's
namespace that, as the filter's comment says, cannot identify a container on
the host.

### Task 2: gvisor-tap-vsock is a reachability question, not a gate one (2026-11-09)

Docker's `dockerd-rootless.sh` 29.9.2 picks slirp4netns when it is installed,
then pasta, then vpnkit, and falls back to gvisor-tap-vsock. This host has
slirp4netns (through the launcher) but no pasta or vpnkit, so slirp4netns is
task 2's evidence, and gvisor-tap-vsock was checked as well. Its host
loopback address is `10.0.2.1`, and through it the peer is `127.0.0.1`, which
the gate admits without new code. What fails is the backend's reachability
check, which only tries `10.0.2.2` and then shows a remediation (enable host
loopback) that cannot help. That is outside this gate and outside tasks 1, 2
and 5, so it became follow-up
[7548](7548-rootless-gvisor-tap-vsock-host-loopback.md) rather than a change
here.

### Task 1: left open rather than run on a substitute (2026-11-09)

The disposable rootless daemon could run the script, but the filter grants no
subnets on rootless, so it would exercise loopback admission again rather
than the subnet path task 1 exists to prove. Running the script inside
RootlessKit's namespace would be refused for the same reason. Task 1 waits
for a rootful daemon this build can reach (4730's nested rootful mode or host
daemon access) instead of counting a substitute.

### Task 5: closed without a host survey (2026-11-09)

Recorded as the recommended option: the gate closes outside peers itself, as
both 2026-11-09 runs showed on a host whose ufw drops incoming traffic by
default. The rejected alternative (per-gateway listeners) keeps the reasons
the report gave. The doc now states the accepted residual exposure.

## Current state

Carried from the security report's S-0170 file (finding L15) when it was closed on 2026-11-05. The agent-tools server still listens on `0.0.0.0`, but it now closes every connection whose peer is not loopback or, on native Linux Engine only, inside a subnet of this backend's own Docker networks, before routing ([Who may connect](../../architecture/container-lifecycle.md#who-may-connect)). It was proven in real containers on Docker Desktop for macOS and, on 2026-11-09, on a rootless Linux daemon through RootlessKit's host loopback (peer `127.0.0.1`). What is left is native rootful Linux Engine (task 1), the C22 case on Linux CI (task 3) and Docker Desktop for Linux (task 4).

The 2026-11-06 review fixes measure freshness and failure backoff from read
completion. Null reads warn and clear permissions. Inspect failures other than
a confirmed network removal invalidate the entire snapshot and log a classified
reason. Deterministic regressions cover these cases; they do not replace the
outstanding live topology evidence.

## Related

- [Who may connect](../../architecture/container-lifecycle.md#who-may-connect)
- Security index, L15 (`git show 413bd6219:docs/reports/security/0000-index.md`)
- [Todo 0109](0109-rootless-linux-runtime-gaps.md)
