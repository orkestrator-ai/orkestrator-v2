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

## Persistent storage (`volume-v1`)

A new environment — or one whose legacy runtime was explicitly discarded — gets
a storage set when the image declares `persistent-workspace`, the daemon is
Engine 26+ (volume sub-path mounts) and `ORKESTRATOR_CONTAINER_STORAGE` is not
`legacy-layer`. An existing legacy runtime is never migrated by a start, read,
status refresh or UI mount; that is the explicit preserving rebuild below.

| Volume | Mount | Holds |
| --- | --- | --- |
| `workspace` | `/workspace` (whole) | Git database, tracked/untracked/ignored files, `.orkestrator` private state |
| `state` | by sub-path only, at each `PROVIDER_STATE_LAYOUT` path | Provider transcripts and the bridges' own journals/session maps |

Rules:

- Planned volume names (owner, environment, storage set, role) are persisted
  before any volume is created; an interrupted attempt adopts only volumes with
  exactly the expected labels.
- A helper container (image's `orkestrator-storage.sh`, entrypoint overridden,
  no network) initializes an empty volume once — ownership, state
  sub-directories, a private marker — and verifies the marker before every
  read-write mount. A non-empty volume without a marker, a foreign marker or
  unexpected ownership is a `needs-attention` condition; nothing is erased or
  recursively re-owned.
- `workspace-setup.sh` refuses to clone when `/workspace` is not a mount point,
  lacks this environment's marker, or holds files but no repository.
- Credentials, configuration, caches and binaries stay in the container layer.
  User-authored secrets can still exist in the workspace or transcripts;
  volumes get private permissions and are never exported implicitly.
- Codex's runtime databases (`CODEX_SQLITE_HOME`) and OpenCode's database
  (`OPENCODE_DB`) are relocated onto the state volume only when that mount is
  present, so a legacy runtime keeps its existing sessions where they are.
- Discarding a volume-backed runtime deletes its storage set (label-verified,
  never forced) and starts a new workspace generation; a volume that will not
  remove stays referenced as a retained copy. Deleting an environment removes
  its volumes after its container, through the cleanup ledger.

Per-provider preservation (`PROVIDER_PRESERVATION`): Claude, Pi and Cursor are
full; Codex (thread-name index not preserved, relocated databases pending
qualification), OpenCode (revert snapshots not preserved) and Grok (root-level
registries not preserved) are partial and say so. Named volumes are
persistence, not backup: a Docker administrator can still remove them.

## Preserving rebuild (`migrate` / `rebuild`)

`recreate_environment` with intent `preserve` and the reviewed
`expectedContainerId` replaces the runtime without losing the workspace
(`container-replacement.ts`). A legacy source is a `migrate`, a volume-backed
source a `rebuild`; both always copy into a **new** storage set, so candidate
setup can never damage the only pre-rebuild copy. A preserving request without
a reviewed container id is still refused `preservation-required`.

| Phase | Effect | Before commit, on failure/cancel/restart |
| --- | --- | --- |
| `preflight` | Pinned image has `persistent-workspace`, local Engine 26+, retention below 16 copies, candidate set planned (persisted as `candidateStorage`) and created, free space measured on the daemon | Candidate removed; nothing else touched |
| `quiescing` | Review validation and exec workers cancelled, previews detached, drain fence + drain, source stopped | Source left stopped; the caller restarts it through the normal start path |
| `copying` → `verified` | `orkestrator-migrate.sh` per step: `docker cp` of the stopped source (never restarted to export it) piped into a no-network helper, or a read-only source volume; per-file SHA-256/mode/size, symlink targets, `git fsck` | Candidate removed |
| `candidate-prepared` → `candidate-healthy` | Generation `n+1` created from the pinned image id, started, current-boot readiness and a mounted `/workspace` checked, stopped again — no setup, agent launch or prompt | Candidate container and volumes removed |
| `committed` | One write moves runtime **and** storage pointers, records the source runtime (and, for `rebuild`, the old set) as retained recovery copies, clears terminal ids | Authoritative; never automatically reverted |

After the commit the normal start path runs setup against the preserved
checkout (the clone is skipped; `createdFromCommit` is kept) and relaunches
agents. Restart reconciliation of an unresolved `migrate`/`rebuild` removes
the candidate by its operation label and keeps the original stopped: the
commit is the write that completes the operation, so an unresolved one never
committed. A candidate volume that will not remove is kept as a
`failed-candidate` retained set rather than orphaned.

Copy policy: bytes, modes, ownership and link targets are preserved and
verified; sockets are skipped; extended attributes are not preserved; sparse
files are copied densely. A copied root that is itself a symlink is refused
(`root-symlink`) because Docker would otherwise deliver nothing for it. Codex
databases (`~/.codex/*.sqlite*`) and OpenCode's `opencode.db*` are relocated
into their state sub-directories; the rest of those homes (configuration,
credentials, caches, OpenCode snapshots) is not copied. Hashes and paths never
leave the helper — its result line carries counts only.

Capacity: the estimate is the source's writable-layer size (`docker ps
--size`) or the measured source volumes, plus 10% and 512 MiB headroom, checked
against free space measured inside a helper on the daemon's filesystem.
Unmeasurable capacity is refused unless the request sets
`allowUnknownCapacity`; a measured shortfall is always refused.

`get_rebuild_preview` describes, before confirmation, whether a rebuild is
possible and exactly which paths and provider formats survive.
`cancel_container_operation` asks an uncommitted replacement to stop at its
next phase boundary (it does not take the lifecycle queue the rebuild holds);
the outcome is recorded as `cancelled` and rolled back like a failure.

## Recovery copies

An environment keeps earlier states as recovery copies (`recovery-copies.ts`,
grouping in `recovery-copy-model.ts`): the runtime a migration or rebuild
replaced, the storage set a rebuild copied from, the runtime and set a reset or
restore set aside, and a candidate set that would not remove
(`failed-candidate`, never restorable). A retained runtime and the set it
mounts are one copy; a legacy runtime is a copy by itself because its writable
layer is the data.

| Action | Effect |
| --- | --- |
| Reset (discard) with `keepRecoveryCopy` | Runtime stopped, not removed; it and its set become a `workspace-reset` copy; new workspace generation. The settings dialog defaults to this. |
| `restore_recovery_copy` | Current runtime quiesced and kept as a `restore-source` copy in the same commit; a retained runtime still present is swapped back in, otherwise a new runtime mounts the verified set. Then the normal start path runs. |
| `discard_recovery_copy` | Removes the copy's container and volumes, label-verified, never forced; whatever does not remove stays referenced for a retry. |

Copies are kept indefinitely — no age-based expiry — and capped at 16 per
environment. Reaching the cap blocks another rebuild or keep-copy reset; it
never evicts a copy. Deleting the environment removes its copies: the cleanup
ledger's container step removes `retainedContainers` and its volume step every
retained set. Mutations bind to the list's lifecycle revision (and, for a
restore, the reviewed container), so a stale review conflicts.

## Reviewed cleanup

`docker_cleanup_preview` lists this registry's containers and volumes with a
classification each (`assigned`, `retained-recovery`, `live-environment-label`,
`operation-in-flight`, `deletion-pending`, `running`, `identity-uncertain`, or
`eligible`) and returns a ten-minute selection token bound to exactly the
eligible set. Another profile's resources are not listed. A volume is eligible
only when it carries this owner, names an environment that no longer exists,
and nothing references it — current storage, a recovery copy, an unresolved
operation's candidate set or a pending deletion.

`docker_cleanup_execute` consumes the token and removes only selected resources
from that set, re-classifying each at removal time: one that became referenced
is a `conflict`, one outside the preview is `not-in-preview`, a volume still
mounted is `skipped` (`in-use`), never forced. Every resource gets its own
outcome. The older `docker_system_prune` / `cleanup_orphaned_containers`
commands stay for earlier renderers and remain container-only.

## Portable inputs (`staged-inputs`)

A container created from an image that declares `staged-inputs` no longer
binds whole host agent homes. `portable-inputs.ts` copies the entrypoint's own
allowlist — for enabled providers only (narrowed to authorized credential
sources in agent-test profiles), plus Git identity — into a private revision
under `<data>/portable-inputs/<environment key>/`, and binds each staged
subtree read-only at the mount point the entrypoint already reads. The two
allowlists must stay in step; a unit test checks every staged target and file
name appears in `entrypoint.sh`.

- Reading: the host home entry itself is resolved (a dotfiles manager may link
  it, and the bind mount it replaces followed that link); nothing below it is
  followed. Every file is opened `O_NOFOLLOW` and re-checked against the
  inode it was listed as. Sockets, devices and FIFOs are never inputs.
- Bounds, enforced while copying: 10 MiB per file, 5,000 entries and 256 MiB
  per directory unit, 20,000 entries and 512 MiB per revision. A skipped entry
  is counted by reason (`symlink`, `too-large`, `aggregate-budget`, …); names
  never leave the backend.
- Publication: a revision is written as `.<rev>.partial` and renamed into
  place, mode `0700`/`0600`. Binds use `--mount`, which fails on a missing
  source instead of creating a host directory. The container carries
  `orkestrator-inputs-revision`; after a successful create, revisions no
  container of the environment still binds are removed (recovery copies keep
  theirs), and the whole root goes with the environment's state directories.
- The Cursor key is no longer in a staged-inputs container's creation
  environment; the bridge reads the synced owner-only file. The Anthropic API
  key (when used instead of OAuth) still is, because Claude Code in terminals
  reads it from the process environment: it is visible to same-user processes
  and in `docker inspect`.
- Older images keep the read-only home mounts their entrypoint expects, and a
  running legacy container keeps them until it is rebuilt; `get_environment_inputs`
  reports that as `host-mounts`, never as narrowed.
- Enabling a provider later is a rebuild, reported as `missingProviders`.
  `revoke_provider_credentials` removes a provider's imported credential files
  from the running container and reports `pendingRebuild` while an immutable
  mount still exposes them. It never touches the host's credentials or revokes
  an account-wide key.

## Environment networks (`network-policy=2`)

A capable image's runtime joins its own bridge network
(`container-network.ts`): `ork-<owner>-<digest>-net`, labelled with owner,
environment and role, created before the container and adopted only with
exactly those labels. A creation failure is an explicit error (`resource-exhausted`
when Docker's address pools are full) and never falls back to the shared
bridge. The container is created with `net.ipv6.conf.all.disable_ipv6=1` and
three policy inputs the root bootstrap captures once, root-owned:

| File | Meaning |
| --- | --- |
| `/etc/orkestrator/network-policy` | `2` (absent means the legacy policy) |
| `/etc/orkestrator/host-service-ports` | Host TCP ports the workload may call (the agent-tools port) |
| `/etc/orkestrator/ingress-ports` | Container ports Docker publishes (bridges, entry and mapped ports) |

GitHub's published ranges come from a backend seed (`github-ranges-cache.ts`,
refreshed at most hourly and mounted read-only at
`/etc/orkestrator-seed/github-ranges`) when it is under a day old, else a live
fetch cached in the container, else either copy under a week old; with none
the firewall fails closed. Reachability is verified against `github.com`, not
the rate-limited API. The report's `githubRanges` says which source applied.

In restricted mode `init-firewall.sh` then allows the host only on those ports
(gateway and `host.docker.internal` addresses) instead of the gateway `/24`,
accepts new inbound connections only on the published ports, drops IPv6 except
loopback (and fails when a non-loopback IPv6 address exists without working
`ip6tables`), allows DNS to the upstreams Docker's embedded resolver lists in
`resolv.conf`, and bounds resolution (256 domains, 32 addresses each, eight
parallel lookups, 3 s per query). It writes `firewall.json` with the applied
state, counts and IPv6 state — in `/run/orkestrator-firewall/`, which only
root can create, on images with `network-refresh=1` (earlier images wrote it
to node's `/run/orkestrator/`); `get_environment_network_policy` reports it
beside the configured mode, and the settings dialog shows both.

### Allowlist refresh and edits (`network-refresh=1`)

The shared library `firewall-domains.sh` builds the `allowed-domains` set for
both the boot and every later change:

- **Expiry.** Each resolved address is added with a kernel timeout of six
  hours after the last answer that contained it; GitHub's ranges are
  permanent until the next rebuild. An address nobody re-confirms leaves the
  set on its own, even when no refresh runs.
- **Refresh.** A root refresher (`update-firewall.sh --refresh-loop`, started
  by `init-firewall.sh` in its own session, single-instance, not signalable by
  node) re-resolves the stored list on the shortest record TTL, clamped to
  5–30 minutes, retrying after 1, 2, 4… minutes (at most 5) while a domain
  fails. A domain keeps the unexpired addresses of earlier answers, so a CDN
  that rotates its answer does not lose open connections; one that stops
  resolving keeps them only until they expire, and the report says how many
  domains are running on such addresses and until when.
- **Atomic replacement.** The next set is built beside the live one and
  swapped in with `ipset swap`; there is never an empty or allow-all set.
- **Revocation.** Entries that leave the set have their tracked connections
  deleted (`conntrack -D`), so an open connection to a removed domain is
  re-checked against the new set and rejected rather than continuing.
- **Edits.** `update-firewall.sh --set-domains <list>` (root, via `docker
  exec`) applies a list and then stores it in `/etc/orkestrator/allowed-domains`,
  so a restart boots with it; `--add`/`--remove` edit the stored list the same
  way. A list with characters outside a domain name is refused unchanged.

The backend identifies a list by `allowedDomainsRevision` — the first 16 hex
digits of SHA-256 over the comma-separated list it configures
(`configuredAllowedDomains`: the environment's or global list plus the hosts
enabled platforms require), which the container reports as `domainsRevision`.
`get_environment_network_policy` compares them: `applied`, `pending` (saved,
applicable in place) or `rebuild-required` (the image predates
`network-refresh`, or the network mode changed). Saving an environment's
domains applies them to the running container in place
(`applyEnvironmentAllowedDomains`, serialized per environment); a start
applies a list saved while the container was stopped; the Network section
offers "Apply now" for anything still pending, such as a global list change.

The agent-tools port can change across backend restarts. Before handing out a
tools URL the backend compares it with the container's durable
`host-service-ports` and, when they differ, runs `update-firewall.sh
--host-ports` as root: the new chain is attached before the old one is
removed, and the policy file is rewritten so a restart applies the same port.

The network is removed by the deletion ledger's `network` step after the
environment's containers (never while one is attached), and reviewed cleanup
offers networks of environments that no longer exist.

## Resource budgets and usage (`container-resources.ts`)

Budgets are opt-in. `global.containerResourceLimits` (Settings → Container)
sets a default for new runtimes and `environment.containerResourceLimits`
overrides it; with neither, a runtime is unrestricted as before, because
defaults must come from measurements (step 13), not guesses. The older
`global.containerResources` slider value was never applied and is no longer
shown or read.

| Axis | Docker | Bounds |
| --- | --- | --- |
| `cpus` | `--cpus` | 0.25–512 |
| `memoryMiB` | `--memory` and `--memory-swap` equal (no swap) | 512 MiB–4 TiB |
| `pids` | `--pids-limit` | 256–4,194,304 |

The applied value is always read back from `docker inspect`
(`HostConfig.NanoCpus`, `Memory`, `PidsLimit`) and reported separately from the
request, with axes the daemon says it cannot enforce. `update_environment_resources`
stores an override and, when asked, applies it to the running container with
`docker update` as an `update-resources` lifecycle operation; it refuses a
limit above the daemon's capacity and a memory limit within 10% of current use
unless explicitly allowed. Docker cannot lift a memory limit from an existing
container; that applies on the next runtime and the read-back says so.

One sampler serves every caller: owner-filtered `docker ps`, one `docker
stats --no-stream` over running containers and one `docker inspect` for OOM and
exit status, deduplicated within 5 s, stale after 15 s, capped at 128
containers. CPU is cores (Docker's per-core percentage ÷ 100, not clamped).
An unreachable daemon yields `null`, never zero. Capacity is `docker info`
(the daemon — on Docker Desktop, its VM — never `os.totalmem()`), cached 60 s;
disk is `docker system df` by kind (images counted once), cached 5 minutes and
unknown when Docker will not say. `get_docker_system_stats` keeps its numeric
shape for older renderers and adds scoped fields (`cpuCoresUsed`, `sampledAt`,
`stale`, `diskKnown`).

## Bounded logs (`bounded-logs=1`)

| Resource | Bound | Where |
| --- | --- | --- |
| Container stdout/stderr | `local` driver, 10 MiB × 3 (new runtimes, when the daemon offers `local`) | `logDriverArguments` |
| Bridge/server output | 5 MiB × 3 per file, lines cut at the file size | `orkestrator-log-writer` |
| Startup failure tail | 64 KiB and 200 lines | `boundedTailCommand` / `boundDiagnosticTail` |
| `get_container_logs` | ≤ 2,000 lines and 512 KiB | registry |
| Follow record | 16 KiB, UTF-8 decoded incrementally | `ContainerLogService` |
| Replay ring | 1 MiB and 2,000 records per source | `ContainerLogService` |
| Followers | one per container, 16 per backend, 5 s idle grace, 60 s lease | `ContainerLogService` |

Bridges and the OpenCode server start through `boundedBackgroundLaunch`: when
the image ships the writer, `setsid sh -c '<cmd> 2>&1 | orkestrator-log-writer
<file>'`, otherwise the plain redirect. The writer owns the open file, so
rotation cannot lose writes behind a still-writing process; it only writes a
local file and drains its input to end of file, so it never blocks or
SIGPIPEs its producer.

`open_container_logs` / `read_container_logs` / `close_container_logs` share
one `docker logs -f` per container among subscribers; a read renews the lease,
a cursor older than the ring or from another source returns an explicit `gap`,
and a replaced runtime is a new source id. Closing releases only the observer.
The legacy `stream_container_logs` is an adapter onto the same service whose
lease lapses, so an old client that never closes cannot leave an immortal
follower. Backend shutdown stops every follower.
