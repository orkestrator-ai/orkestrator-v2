# Container lifecycle

Living guide to how the backend owns environment containers. The rollout plan
and its implementation records are in
[`docs/improvements/containers/plan/`](../improvements/containers/plan/00-index.md).

## Authority

Backend storage plus verified Docker state is authoritative. React state and
live events are projections: every lifecycle change is persisted before it is
emitted, and a remounted client rehydrates from the environment snapshot.

Every container mutation runs as one **durable operation** recorded in the
environment's `containerLifecycle` record
(`packages/protocol/src/container-lifecycle.ts`,
`apps/backend/src/core/container-lifecycle-service.ts`):

| Field | Meaning |
| --- | --- |
| `revision` | Monotonic; bumped by every persisted lifecycle change. |
| `runtime` | Committed container: id, `runtimeGeneration`, owner, image reference/id. |
| `lastRuntimeGeneration` | Highest generation ever assigned; a replacement always gets a new one. |
| `storage` | Storage identity (`legacy-layer` until persistent volumes). |
| `operation` | The single unresolved operation: kind, phase, status, source/candidate. |
| `outcomes` | Last 32 terminal outcomes, for request deduplication. |
| `outcomeHorizon` | Operation ids at or before it have aged out and are refused. |

The record is capped at 64 KiB. Clients receive `ContainerLifecycleSnapshot`,
a safe projection with no container ids.

### Rules

- **Intent first.** A phase is persisted before the Docker effect it names
  (`creating` before `docker create`, `removing` before `docker rm`).
- **One writer.** The per-environment lifecycle queue serializes operations in
  a process; the registry writer lease
  (`container-lifecycle.writer.lease`, heartbeat file) excludes other backends
  pointed at the same data directory. Lock order: lifecycle queue, then
  lifecycle record; the service never enqueues on the queue itself.
- **Dedup, never redispatch.** A request carrying an `operationId` (UUIDv7)
  that already finished returns its stored outcome. One older than the
  retained horizon is answered `operation-unknown`, not run again.
- **Conflicts are explicit.** `expectedRevision` mismatches answer
  `revision-conflict`; a second operation while one is unresolved answers
  `operation-in-progress` or `needs-attention`.
- **Authorize before admission.** Ownership is checked before an operation is
  recorded, so a refusal writes nothing.

Typed failures cross the command transport as
`ContainerLifecycleError:<code>: <message>`; parse them with
`parseContainerLifecycleError`.

## Ownership

A caller-supplied container id is never proof of ownership, in any profile.

- A container is owned when it carries this app's label and this registry's
  owner label (`dockerOwnerNamespace(dataDir)`). Positive verdicts are cached
  per container id; labels are immutable.
- A pre-label container (app label, no owner label) is owned only when an
  environment record already references it, and never under a strict
  (agent-test) profile.
- The command registry wrapper additionally accepts an **exact** persisted
  association without a Docker probe outside strict profiles; prefixes never
  match, since Docker would resolve a prefix to any container. Lifecycle
  mutations (start, stop, discard, delete) always verify labels.
- A missing container is allowed through (there is nothing to protect and the
  repair actions must work); an unreachable daemon or unreadable answer is
  refused with `daemon-unavailable`.
- `reattach_container` is an explicit adoption: owned or reviewed pre-label
  container, not already attached, not labelled for another live environment.

Raw commands are adapters: `docker_start_container`/`docker_stop_container` on
an environment's runtime go through the lifecycle queue and an operation;
`docker_remove_container` refuses any claimed container; `provision_environment`
is idempotent.

## Identities and labels

New containers carry `orkestrator-operation-id` and
`orkestrator-runtime-generation` labels. Generation 1 keeps the historical
name `ork-<owner>-<environment>`; later generations get `-g<n>` so a
replacement never depends on the old name being free.

## Recovery

At startup (after the writer lease is acquired and before background launch or
cleanup) and whenever a new operation finds a stale one, the service reconciles
by exact identity:

| Observed state | Action |
| --- | --- |
| Intent, no labelled container | Settle as `interrupted`; nothing is created |
| Create interrupted, one labelled container | Adopt it; never create a second |
| Several labelled containers | `needs-attention`; keep all, refuse new writers until `resolve_container_operation` |
| Docker unreachable | Keep the operation; retry at the next admission |
| Labelled container owned by another registry | Ignored (filtered by owner label) |
| Deletion tombstone | Settle; the deletion continuation owns every resource |
| Removal interrupted, container gone | Clear the reference |
| Repeated completed request | Return the stored outcome |

## Schema floor and downgrade

`container-lifecycle.schema.json` records the minimum lifecycle writer allowed
to mutate the directory. A backend below it (or facing an unreadable marker)
opens a blocked writer: reads work, every container mutation answers
`unsupported-format`. A lifecycle record with a higher `schemaVersion` blocks
mutation and deletion of that environment.

The rollback floor is the first release that ships the marker. Earlier
binaries ignore it; a manual downgrade below the floor bypasses the protection
and is unsupported.

## Commands

| Command | Purpose |
| --- | --- |
| `get_container_lifecycle_snapshot` | Snapshot read that works after missed events |
| `resolve_container_operation` | Settle a `needs-attention` operation (`adopt` a candidate or `release`) |
| `start_environment` / `stop_environment` | Accept optional `operationId`, `expectedRevision` |
| `recreate_environment` | `intent` (`preserve` default, refused for legacy) / `discard` + `expectedContainerId` |

Any command may send `expectedRuntimeGeneration`; a replaced runtime answers
`runtime-changed` instead of connecting the handle to the new container.

## Images

An operation resolves the configured tag once, at admission
(`resolveOperationImage`), persists the immutable image id (and registry
digest when the image came from a registry) in the operation, and creates the
container from that id. Moving the tag mid-operation cannot change what the
candidate runs. A missing image fails before anything is created.

Each image carries a manifest at `/usr/local/share/orkestrator/image-manifest.json`
(`packages/protocol/src/image-manifest.ts`), generated during the build by
`docker/image-manifest.ts` from the Dockerfile's ARG pins:

- **Capabilities are probed, not declared.** A contract script carries a
  `ORKESTRATOR_CAPABILITY <name>=<version>` marker; a capability is in the
  manifest only when its marker is present in the file installed at the
  contract path. The build host probes the repository sources to stamp the
  same list into the `org.orkestrator.image.capabilities` label, and the image
  build fails if the installed files disagree (`scripts/docker-image-build-args.ts`).
- **Read without running.** The backend reads the manifest from an owned,
  labelled, network-less container that is never started, copies the file out
  as a bounded tar stream (regular file, ≤ 64 KiB) and removes the container;
  an interrupted probe is reclaimed at startup. Results are cached by image id.
- **Legacy means legacy.** An image without a manifest keeps its guarded
  operations and never gains a capability by default.

`get_docker_image_status` reports `missing`, `compatible`, `legacy`,
`incompatible` or `unavailable` with the missing capabilities and fixed
remediation text. `check_base_image` remains a presence-only adapter.

## Daemon topology

`detectDockerTopology` reads the current context's endpoint (which reflects
`DOCKER_HOST`/`DOCKER_CONTEXT`) and `docker info`, and keeps only fixed
categories: `local-engine`, `desktop`, `remote`, `unknown`, `unavailable`, plus
`rootless` and the server version. Raw endpoints are never persisted or
emitted.

Bind mounts name backend-host paths and bridges are reached on backend
loopback ports, so container creation on a **remote** daemon is refused with
`unsupported-topology`. The supported remote workflow is the standalone
backend beside its daemon plus the remote gateway. The `host.docker.internal`
host-gateway alias is added only for a Linux Engine; Docker Desktop (including
Desktop for Linux) provides its own DNS entry.

Qualified locally: Docker Engine 29.7.2 on Linux amd64. Docker Desktop and
rootless daemons are detected and reported but not yet qualified; features
that depend on cgroup or firewall enforcement gate on them explicitly.

## Readiness

An image with the `boot-status` capability writes
`/run/orkestrator/boot-status.json` atomically at each phase
(`initializing`, `network-ready`, `inputs-ready`, `ready`, or `failed` with a
fixed code such as `firewall-failed`, `firewall-missing`, `entrypoint-failed`).
The entrypoint removes the legacy markers and the previous record before doing
anything else. A record counts only when its `pid1Start` equals the start time
of the container's current PID 1 (`/proc/1/stat`), which changes on every
start, so a record or marker from an earlier boot can never release work.

- A start of a capable runtime waits for `ready` (default 120 s, separate from
  clone/setup/bridge deadlines) before setup or agents run; a failed boot, an
  exited container or a timeout is a typed, retryable `not-ready` failure.
- Immediately before workspace preparation and before a bridge launch, the
  backend rechecks the current boot and waits if Docker restarted the
  container in between. A legacy image, or a probe that cannot be answered,
  does not gate dispatch.
- `workspace-setup.sh` applies the same rule inside the container and fails
  (retryably) instead of "proceeding anyway" on timeout.
- In restricted mode a missing firewall script is as fatal as a failed one.

Readiness is orchestration evidence, not a security boundary against the
container user.

## Setup completion

A successful setup records which runtime generation and workspace generation
it belongs to. A legacy writable-layer workspace dies with its runtime, so a
new runtime generation invalidates the completion; persistent storage keeps it
until the workspace generation changes. Setup interrupted by a backend exit is
fenced as failed and requires an explicit retry; repository commands are never
rerun automatically.

## Stop and drain

An image with the `graceful-shutdown` capability runs under Docker's `--init`
(signal forwarding, orphan reaping). An explicit stop:

1. persists the `draining` phase and fences new bridges, terminals and setup
   for that environment;
2. runs `/usr/local/bin/orkestrator-drain.sh` as root, which sends SIGTERM to
   every workload process except PID 1 and the recorded keepalive and waits up
   to 10 s;
3. runs `docker stop`, then records `forced: true` if anything survived the
   drain or Docker had to SIGKILL PID 1.

Backend shutdown never stops user containers; their processes are rehydrated
and uncertain operations reconciled on the next start. Approvals are never
approved by a stop: bridges deny or withdraw on the way out.
