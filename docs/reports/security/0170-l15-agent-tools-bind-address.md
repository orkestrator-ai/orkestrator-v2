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
