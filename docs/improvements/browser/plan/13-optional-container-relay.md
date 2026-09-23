# 13 — Add an optional in-container service relay

Status: Not started; optional extension. Depends on: 04–07, 12.
Not required for the initial published-port desktop/browser release.

## Outcome and design boundary

Preview a newly started or container-loopback-only application without destroying
and recreating the container to add Docker publication. The relay runs in the
owned container's network namespace, where `127.0.0.1:<app-port>` refers to the
application. It is separate from the client-to-backend transport.

Suggested owners: new `preview-relay-supervisor.ts` and relay entrypoint;
[Docker image](../../../../docker/Dockerfile),
[container lifecycle](../../../../apps/backend/src/core/commands-containers.ts), and
[environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts).
Do not attach application data transport to an agent bridge's stdout loop.

## Feasibility gate

Compare a dedicated `docker exec`-supervised stdio relay and a small authenticated
relay listener provisioned when the container is created. The first can serve
existing containers without new published ports but adds child-process/stdio
lifecycle work. The second simplifies connections but does not solve upgrades
for already-running containers by itself.

Record process count, binary availability, ownership, permissions, cancellation,
cross-platform Docker behavior, and upgrade strategy. Prefer one bounded relay
process per environment with an explicitly bounded channel scheduler if proven;
a process per connection is acceptable only with a measured strict cap. Do not
introduce an unbounded `docker exec` spawn per asset request.

## Implementation tasks

1. Start the selected relay through verified container ownership and the existing
   lifecycle task mechanism. Capture container identity and generation; reject
   stale relays after recreation even if a name is reused.
2. Provide private ephemeral authentication through a channel that avoids command
   line/process listing/log exposure. The relay can open only registered service
   ports authorized by the backend; it is not a general shell or arbitrary
   destination proxy.
3. Define version/capability handshake and bounded request/data frames. Use
   existing preview transport semantics where appropriate, but keep endpoint
   resolution inside the container explicit.
4. Support HTTP/WS byte transport and the accepted TLS mode without rewriting
   application bodies. Resolve container `localhost` address families correctly.
5. Apply per-channel/global byte limits, channel/process counts, admission,
   connect deadlines, backpressure, cancellation, and close/half-close semantics.
   A blocked channel cannot stall all environment traffic or agent sessions.
6. Install fatal rejection guard and supervision appropriate to the entrypoint.
   A relay crash marks relay-backed services unavailable; it does not terminate
   the backend or claim applications have stopped.
7. Reconcile/reattach idempotently after backend restart. A restarted relay gets
   a new generation and grants; never replay ambiguous application writes.
8. Stop owned relays on environment deletion and backend shutdown according to
   the selected supervised-process policy. UI unmount does not own this cleanup.

## Resolver and product integration

Add `container-relay` as a resolver adapter. Prefer a healthy existing publication
unless the service requires relay access or the chosen policy selects it. Report
the actual transport in readiness. A failing published connection does not prove
container-loopback binding; probe the relay path to establish the distinction.

Register a discovered/new port explicitly. Do not grant arbitrary port access
because a relay has broad network reach inside the container. Respect network
policy and exclude agent bridge/control endpoints from ordinary preview choices.

Old images without relay capability show unsupported with publication/recreation
as an explicit alternative. Do not force an image rebuild/recreation merely to
open an existing published service. Container image changes require normal
build/upgrade documentation and opt-in fixture validation.

## Tests and completion

Use an owned container with an HTTP/WS app bound only to `127.0.0.1:3000` and no
host publication. Prove preview works while a normal host mapping cannot reach
that listener. Start another service on a new port and register it without
recreation. Verify the container ID and running agent process survive.

Cover wrong-owner container, dead/recreated container, relay crash/restart,
version mismatch, denied service port, many small channels, large/slow streams,
disconnect, malformed frames, and backend shutdown. Assert process/channel
counts return to baseline and no terminal/agent output loop waits on relay I/O.

Run the inactive-environment case and both Linux Docker and Docker Desktop.
Exit only with bounded resource evidence and documented old-image behavior.
If this step is deferred, leave its capability disabled and explicitly retain
the published-port limitation in product documentation.
