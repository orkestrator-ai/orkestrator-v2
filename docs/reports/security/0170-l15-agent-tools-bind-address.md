# Stop the agent-tools server listening on every interface

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Narrow who can reach the agent-tools server**: it binds `0.0.0.0` on the host. Status: open.

### 1. Narrow who can reach the agent-tools server

**Problem.** The server is protected by a token, but it can be reached from the LAN or tailnet, so anyone there can probe it and any token leak is usable from outside the host.

**Context.** Containers reach it at `host.docker.internal:<port>` (`apps/backend/src/core/agent-tools.ts:1067`, `:1187`). The report suggests binding to the Docker bridge or loopback addresses. Each environment on policy 2 or later has its own network and gateway address (`environmentNetworkName`, `apps/backend/src/core/container-network.ts:56`), so there is no single bridge address. Rootless Docker reaches it through RootlessKit's host loopback ([todo 0109](../../todo/containers-and-environments/0109-rootless-linux-runtime-gaps.md)).

**Investigation.** The default is `0.0.0.0` (`apps/backend/src/core/agent-tools.ts:977`), it is listened on at `:1001`, and production passes it explicitly (`apps/backend/src/core/index.ts:536`). The server answers any non-POST with 405 before authenticating, which the reachability probe relies on (`docs/architecture/container-lifecycle.md:1105-1110`), so an outside peer learns the port is open.

**Decisions.**

- **How to narrow it?**
  - **Keep the wildcard listener and refuse peers outside loopback and the backend's own Docker network subnets, before routing (recommended).**
    - Pros: a stable port; no listener per network; no privileges needed; the reachability probe keeps working from containers.
    - Cons: the LAN still sees an open port that closes at once; the subnet list must follow network creation, and Docker Desktop's peer addresses need checking.
  - **One listener per Docker network gateway address, plus loopback.**
    - Pros: what the report suggests; nothing on the LAN or tailnet.
    - Cons: listeners come and go with environments; addresses are not known until a network exists, and a port must be free on each.
  - **Loopback only, with containers going through a forwarder.**
    - Pros: the tightest bind.
    - Cons: a new moving part; on Linux Engine, a container's `host-gateway` address does not reach host loopback.

## Needs verification

Nothing was run for this file.

- Which peer address the server sees for a container on Linux Engine, rootless Docker and Docker Desktop.
- Whether a host firewall already hides this port on typical hosts. ufw's default drop is mentioned in the lifecycle document only as something that breaks containers.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L15)
- [Todo 0109](../../todo/containers-and-environments/0109-rootless-linux-runtime-gaps.md)

## Outcome

Built 2026-11-05 from `main` at `0db245422` (batch S-0170) and rebased onto `main` at `31dce31cb` on 2026-11-06. The recommended option was taken: the wildcard listener stays, and peers outside loopback and this backend's Docker network subnets are closed before routing. Line numbers below are from the branch.

| Item | Outcome | Evidence |
| --- | --- | --- |
| Context: default bind `agent-tools.ts:977`, listen `:1001`, production bind `index.ts:536`, `environmentNetworkName` `container-network.ts:56` | Re-checked; still current, lines moved | Default `apps/backend/src/core/agent-tools.ts:1004`, listen `:1053`, production `apps/backend/src/core/index.ts:555`, `environmentNetworkName` `apps/backend/src/core/container-network.ts:58`; containers still use `host.docker.internal` (`agent-tools.ts:1120`, `:1137`, `:1191`) |
| Investigation: the 405 before authenticating reveals the port | Done | Requests now pass through `admitAndHandle` (`agent-tools.ts:1490`) before `handle` routes anything, and a peer the current list refuses is closed on accept (`agent-tools.ts:1045`); the 405 at `:1530` is reached only by admitted peers. HTTP parser errors destroy the socket (`:1035`) and automatic Expect replies wait for admission (`:1037`). `agent-tools-peer-gate.test.ts` sends GET `/mcp`, GET to an unknown path and an unauthenticated POST as a refused peer and receives zero bytes for each; malformed, oversized and Expect requests from an undecided peer also get zero bytes |
| Task 1, decision: keep the wildcard and refuse outside peers before routing | Done | `apps/backend/src/core/agent-tools-peer-filter.ts` (loopback everywhere; on native Linux Engine only, also the default `bridge` and owner-labelled network subnets); unit tests `agent-tools-peer-filter.test.ts` (34) and `agent-tools-peer-gate.test.ts` (8), including a real request to the host's own non-loopback address on a `0.0.0.0` listener |
| Task 1, con: the subnet list must follow network creation | Done | `apps/backend/src/core/docker-network-changes.ts`, reported from `ensureEnvironmentNetwork` and `removeEnvironmentNetwork` (`container-network.ts:120`, `:152`, `:166`, `:188`), the probe network's create and removal and the stale-probe reap (`container-host-reachability.ts:1289`, `:971`, `:1401`) and reviewed cleanup (`docker-cleanup-preview.ts:349`); every non-loopback peer, cached members included, also reloads, at most once per 15 s counted from when the last read completed; a failed or incomplete read (any Docker list or inspect failure other than a confirmed network removal) revokes cached permissions and logs a classified warning until a successful retry, and a request waits for every replacement read, so a superseded read cannot admit a removed subnet. Tested in `agent-tools-peer-filter.test.ts` and live (the environment network's subnet left the list when it was removed) |
| Task 1, con: Docker Desktop's peer addresses need checking | Done | On Docker Desktop 4.98.0 (Engine 29.9.2, arm64, macOS) the server saw `127.0.0.1` for containers on an environment network, the default bridge and an unowned network; recorded in [container-lifecycle.md](../../architecture/container-lifecycle.md#who-may-connect). Because Desktop's VM-internal subnets can overlap host LAN or VPN ranges, non-Linux hosts and Desktop (detected on Linux from `docker info`'s `OSType` and `OperatingSystem` on every refresh) admit loopback only (`dockerPeerFilter`, `agent-tools-peer-filter.ts:301`); unavailable or malformed topology revokes subnet permissions. A 2026-11-06 rerun with this rule gave the same results: all three container sources 405 as `127.0.0.1`, both probes reachable, LAN and tailnet closed with no bytes, an empty subnet list and no leftovers |
| Context: rootless reaches the server through RootlessKit's host loopback | Not run here | Expected to arrive as loopback and be admitted; [todo 6820](../../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 2 |
| The container reachability probe must keep working | Done | Live: the probe from inside the environment container and both throwaway-container probes (run through the Linux code path with `--platform-linux`) were `reachable`, HTTP 405 |
| Evidence: a container on an environment network reaches the server | Done (Docker Desktop) | Live: a busybox container on a network made by `ensureEnvironmentNetwork` got HTTP 405 from `GET /mcp`. Linux Engine in [todo 6820](../../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 1 |
| Evidence: a non-allowed source is refused before routing | Done | Live: requests from the host to its LAN (`192.168.4.51`) and tailnet (`100.81.128.8`) addresses were closed with no bytes; the server saw those addresses as the peers |
| Needs verification: the peer address on Linux Engine, rootless and Docker Desktop | Partly done | Docker Desktop for macOS recorded above; Linux Engine, rootless and Docker Desktop for Linux in [todo 6820](../../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) tasks 1, 2 and 4 |
| Needs verification: whether a host firewall already hides the port | Carried | No longer needed for the gate itself; [todo 6820](../../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 5 records the decision |
| Live qualification case C22 | Changed, not run | Its server's data directory differs from the scene's, so it now passes `dockerPeerFilter(() => scene.owner)` (`apps/backend/tests/container-live-readiness.test.ts`); its Linux CI run is [todo 6820](../../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 3 |

How the live evidence was taken: `mise exec -- bun apps/backend/scripts/agent-tools-peer-evidence.ts --platform-linux`, twice, against a throwaway data directory and an ephemeral port. An isolated `dev:test` profile was not used: on macOS it opens a native Electron window on the live desktop and seeds provider logins from the Keychain, both ruled out for this build. Every container and network the script created carried `orkestrator-s0170-evidence=1` or the throwaway owner label and was removed by it; its leftovers check found none. Docker was not restarted or pruned, and no firewall or network setting was changed. The pinned busybox probe image was not on the host; it was pulled for the runs and removed afterwards, with no container using it.
