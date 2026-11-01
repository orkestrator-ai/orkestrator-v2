# Container lifecycle

Living guide to how the backend owns environment containers. Qualifying a
change against a real daemon is in
[container-qualification.md](../development/container-qualification.md);
outstanding work is in `docs/todo/containers-and-environments/`, starting with
[0019-container-platform-qualification.md](../todo/containers-and-environments/0019-container-platform-qualification.md).

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
| `storage` | Storage format (`legacy-layer` or `volume-v1`), `workspaceGeneration` and, for volumes, the `storageSetId` and volume references. |
| `operation` | The single unresolved operation: kind, phase, status, source/candidate. |
| `outcomes` | Last 32 terminal outcomes, for request deduplication; each carries `durationMs` and per-phase `phases` timings when it ran in one process. |
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
Generations only increase, including when a recovery copy's runtime is
swapped back in, so a handle bound before a rebuild never matches again.

## Images

An operation resolves the configured tag once, at admission
(`resolveOperationImage`), persists the immutable image id (and registry
digest when the image came from a registry) in the operation, and creates the
container from that id. Moving the tag mid-operation cannot change what the
candidate runs. A missing image fails before anything is created.

Each image carries a manifest at `/usr/local/share/orkestrator/image-manifest.json`
(`packages/protocol/src/image-manifest.ts`), generated during the build by
`docker/image-manifest.ts`:

- **Versions are what is installed.** Each agent CLI and runtime is asked for
  its version; the build fails when one disagrees with its ARG pin, so the
  manifest names what the image runs, not only what the Dockerfile asked for.
  A bridge is listed only when its built entry point (`dist/index.js`) exists.

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

- **State formats are enforced.** A runtime is given `volume-v1` storage
  only when its image declares it writes the current version for both roles
  (`imageWritesVolumeStorage`); otherwise creation fails `unsupported-format`
  before anything exists, so an older image never gets newer state mounted
  read-write.

`docker/tests/final-image-smoke.sh <image>` runs a built image with no
network and checks the manifest's versions against the installed CLIs, every
listed bridge's `/global/health`, Codex's code-mode host and Chromium; CI runs
it on the native amd64 and arm64 builds, which also pass the contract build
arguments so the capability label is verified. `docker/build.sh [tag]` builds
from the repository root with those arguments.

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

Qualified locally: Docker Engine 29.7.2 on Linux amd64 and Docker Desktop
4.93.0 to 4.95.0 (Engine 29.8.1 and 29.8.2) on Apple Silicon (native arm64).
Rootless daemons are supported with gated features but not yet qualified on a
Linux host. A resource budget axis the daemon reports it cannot enforce is
refused (see [Resource budgets](#resource-budgets-and-usage-container-resourcests)),
and a restricted firewall that cannot be applied fails the boot closed. The
evidence and what each run covered are in
[container-qualification.md](../development/container-qualification.md).

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
- The root repair of `/project-files` access runs after readiness, because a
  boot that fails closed exits at once and an earlier repair `docker exec`
  turned that typed `not-ready` into an untyped "container is not running"
  error. Account startup may invalidate the Codex marker with a pre-readiness
  `docker exec`; this is deliberately best-effort, with failures caught and
  logged so they cannot preempt the readiness result.
- The wait is not a host-side poll. Each `docker exec` waits inside the
  container for up to 2 s, re-reading the record every 50 ms, and returns as
  soon as the current boot (its `pid1Start` is PID 1's) reports `ready` or
  `failed`; the backend then parses what it printed exactly as it would a
  single read. A boot is seen within about 50 ms of the record, and a wait
  costs one Docker call per 2 s window rather than one per 250 ms. A probe
  that comes back early with no final state is spaced 250 ms apart, and an
  unreachable container backs off as before. The rechecks before dispatch
  stay single reads. (Todo
  [0870](../todo/containers-and-environments/0870-container-start-poll-quantisation.md).)
- A boot that fails closed usually exits within the probe's window, which
  ends the exec. Once the
  container has stopped, the backend reads its final boot record with
  `docker cp` (which needs no running process) and reports that record's code
  (`firewall-missing`, `firewall-failed`, …). PID 1 is gone, so the record
  counts only if its `updatedAt` is not before the run's `State.StartedAt`; a
  record an earlier start left, or none, reads `container-exited`. A restart
  during launch can read `entrypoint-failed`: the held entrypoint records its
  own exit on SIGTERM.

Qualified live by `container-live-readiness.test.ts`: missing firewall
script, DNS and bootstrap failure, an unwritable status directory, a torn
status write, a container restart during launch, a firewall re-run that
loses DNS (C23) and setup interrupted after a side effect (C10).

Readiness is orchestration evidence, not a security boundary against the
container user.

## Setup completion

A successful setup records which runtime generation and workspace generation
it belongs to. A legacy writable-layer workspace dies with its runtime, so a
new runtime generation invalidates the completion; persistent storage keeps it
until the workspace generation changes. Setup interrupted by a backend exit is
fenced as failed and requires an explicit retry; repository commands are never
rerun automatically.

Setup runs `workspace-setup.sh` under `flock
/tmp/orkestrator-workspace-setup.lock`. If the setup terminal's host process
dies, that run carries on inside the container and keeps the lock; the
backend reports the setup failed and reruns nothing (C10). An explicit retry
then waits for it rather than starting setup a second time or stopping it
part-way, and says so first ("An earlier setup run is still running in this
container … Waiting for it to finish instead of starting setup a second
time."; `CONTAINER_WORKSPACE_SETUP_COMMAND`). When the earlier run succeeded,
the script then reports "Workspace already set up" and the retry completes;
its output went to the terminal that closed. When it failed, the retry runs
setup itself.

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
and uncertain operations reconciled on the next start.

A stop never approves a pending approval. The drain signals the bridge and the
provider process that raised the request, so nothing is left that could act on
it (Claude's bridge has no shutdown handler of its own and simply exits). Once
the stop commits, `NativeAgentService.environmentRuntimeStopped` does two
things. It drops the environment's outstanding requests from every cached
session projection in a new announced revision
(`withdrawEnvironmentInteractions`), fenced so a refresh that read them before
the stop cannot commit them back. The public CLI (`session get`,
`session interactions`) and the coordinator's `get_tab_state` read that
projection, so they no longer report a dead request as pending. And it settles
each session's last observed turn activity to `idle`
(`settleStoppedSessions`), fencing activity reads still in flight: the sweep
skips environments that are not ready, so a session last seen `waiting` used
to stay `waiting` while stopped, and `session send` and a move refused it as
busy. The settle is quiet. No activity transition is announced and no
completion recorded, because a turn cut off by a stop did not finish:
announcing one would report a worker as done to its coordinator, drain queued
prompts into the stopped environment and probe for a PR. The next start reads
`idle` against `idle`, so it fires no "finished" edge either. A run whose turn
was cut off settles `interrupted` (evidence `none`) instead of waiting for an
outcome no bridge can report.

A local stop settles only when every bridge terminated. The quiesce before a
rebuild or a recovery-copy restore does the same as an explicit stop, and the
activity sweep catches a container runtime that stopped any other way (found
exited by lifecycle reconciliation): once per stop, for container
environments whose status is `stopped`. Qualified live for Claude (C11,
`e2e/agent-testing/container-approval-stop.spec.ts`); the activity settle is
covered by `native-agent-service-stopped-runtime.test.ts`.

A stop also clears the renderer's local panes for that environment, together
with its hydration state. It releases only local views: no native or tmux tab
teardown is requested, since one queued against the stopped bridge would close
the session after the restart. Agent tabs and their sessions outlive the
runtime, so the next start restores the persisted layout from the backend
rather than seeding a default terminal. The backend refuses a layout written for another
runtime generation, so the cleared local copy can never overwrite the durable
one.

## Persistent storage (`volume-v1`)

A new environment — or one whose legacy runtime was explicitly discarded — gets
a storage set when the image declares `persistent-workspace` and the daemon is
Engine 26+ (volume sub-path mounts), rootful or rootless. An existing legacy runtime is never migrated by a start, read,
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

### Provider state

`PROVIDER_STATE_LAYOUT` (`container-state-layout.ts`) lists every
resume-critical path; each is mounted from its own `state` sub-directory at
exactly that path, so the rest of a provider home stays in the container
layer. The container user is `node` (`HOME=/home/node`) and no launcher sets a
vendor-home variable. Bridge journals and session maps are preserved with
their provider's transcripts, because the host's provider session id cannot
be resolved without them, and an ambiguous dispatch survives reconstruction
as unknown rather than unsent.

Traced against the versions in `PROVIDER_STATE_TRACED_VERSIONS` (Claude CLI
2.1.314, Codex 0.166.0, OpenCode 1.19.5, Pi 1.4.0, `@cursor/sdk` 1.2.0, Grok
1.0.70), by reading the pinned binaries' strings and bundled docs. A pin bump
fails `apps/backend/tests/container-state-layout.test.ts` until the layout is
re-traced ([upgrading agents](../development/upgrade-agents.md#re-trace-preserved-provider-state)).

| Provider | Preserved (`state` sub-directory → mount) | Not preserved |
| --- | --- | --- |
| Claude | `claude/projects` → `~/.claude/projects` (SDK transcripts); `claude/file-history` → `~/.claude/file-history` (rewind); `claude/orkestrator` → `~/.claude/orkestrator` (bridge dispatch and steer journals, preferences) | `.credentials.json`, settings, `commands`/`skills`/`agents`/`plugins`, caches, `~/.claude.json` |
| Codex | `codex/sessions`, `codex/archived_sessions` (rollouts, fork lineage); `codex/orkestrator-bridge` (session map, dispatch journal, the title index that keeps names set in Orkestrator); `codex/sqlite` at `CODEX_SQLITE_HOME` (every `*_N.sqlite` runtime database: state, thread history, goals, queue, memories, logs) | `session_index.jsonl` (Codex's own thread names, at the home root; only a name set in the Codex CLI itself is lost), `history.jsonl` (prompt recall), `shell_snapshots`, `auth.json`, `config.toml`, caches |
| OpenCode | `opencode/db` via `OPENCODE_DB` (session database: sessions, messages, parts, todos, permissions, console accounts and selected organization) | `snapshot/` (revert and diff git directory, recreated on demand), `tool-output/` (full copies of truncated tool output), `storage/` (the legacy-migration index and each session's saved change list, `session_diff/`), the TUI state under `~/.local/state/opencode`, `auth.json`, configuration, plugins, mise installs under `~/.local/share` |
| Pi | `pi/sessions` → `~/.pi/agent/sessions` (`PI_SESSION_DIR`); `pi/bridge-state` → `/tmp/orkestrator-pi-state` | `auth.json`, `models.json`, settings, extensions, themes |
| Cursor | `cursor/bridge-state` → `/tmp/orkestrator-cursor-sdk-state` (SDK agent store and bridge journals) | `/tmp/orkestrator-ai/cursor-sdk-auth.json`, API-key files, `~/.cursor/mcp.json` (a staged input: snapshotted at creation, re-imported on every start), other `~/.cursor` auxiliaries |
| Grok | `grok/sessions` → `~/.grok/sessions` (per-cwd session directories, which hold everything `session/load` reads, and the rebuildable search index); `grok/bridge-state` → `/tmp/orkestrator-acp-state` | `active_sessions.json` (live-process registry), `worktrees.db` (registry of Grok's own worktrees, which live outside the preserved set), opt-in `memory-v2/`, `auth.json`, configuration |

Provider MCP configuration is never preserved in the container: the
entrypoint copies it from the staged inputs on every boot. A container
environment's own MCP changes live in the backend's environment overlay
(`mcp-environment-overlays` state root, keyed by environment id), which the
backend writes back over the fresh copies after every boot, so they survive
stop and start, a preserving rebuild and a backend restart without being part
of any volume or recovery copy
([`mcp-management.md`](mcp-management.md#containers)).

SQLite stores (Codex runtime databases, OpenCode's database, Grok's search
index) keep their `-wal` and `-shm` files beside them on the volume, and are
copied only with their writer stopped. Packages installed outside the
preserved paths (`/usr`, `/opt`, the rest of the home) do not survive a new
runtime; they must come from the image or project setup.

`PROVIDER_PRESERVATION` is what the product may claim, and its limitation
text reaches the user through the rebuild preview: Claude, Pi and Cursor
are `full`; Codex, OpenCode and Grok are `partial` because of the paths above
(Codex's relocated databases are also pending qualification). Resume after a rebuild is qualified only for the providers in
`RESUME_QUALIFIED_PROVIDERS`. Named volumes are persistence, not backup: a
Docker administrator can still remove them.

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

Copy policy (`docker/orkestrator-migrate.sh`): bytes, modes, numeric
ownership, symlink targets and hard links are preserved and verified; FIFOs
are recreated; device nodes are refused (`unsupported`); sockets are skipped;
sparse files are copied densely. File capabilities (`security.capability`)
and `user.*` extended attributes are kept on extraction but not verified. A
legacy source arrives as a `docker cp` archive, which carries file
capabilities but not `user.*` attributes; a volume source is archived with
both. Images built before 2026-10-25 archived a volume source without them,
so their volume rebuilds dropped file capabilities. Host labels such as
`security.selinux` are never copied. A copied root that is itself a symlink is refused
(`root-symlink`) because Docker would otherwise deliver nothing for it. The
root is the archive's first member, read from the whole stream even when a
step selects members, so a selection that matches nothing (a `~/.codex` with
no databases yet, which every image has) is a complete, empty copy, and a
listing that did not finish fails the step. Images
built before 2026-10-26 read the root from the selected listing and refused
such a step as `root-symlink`, which blocked migrating any legacy environment
without Codex or OpenCode databases. Codex
databases (`~/.codex/*.sqlite*`) and OpenCode's `opencode.db*` are relocated
into their state sub-directories; the rest of those homes (configuration,
credentials, caches, OpenCode snapshots) is not copied. Hashes and paths never
leave the helper — its result line carries counts only.

A source path counts as absent (nothing to preserve) only when the daemon
itself answers `Error response from daemon: Could not find the file`. Any
other failure to read the source, including the CLI's own `connect: no such
file or directory` when the daemon socket is gone, fails the step and rolls
back with the original authoritative; an outage that ended mid-copy once let
an empty candidate commit. When the helper side of a copy dies, the
producer's remaining output is discarded so both processes settle, rather
than leaving the rebuild holding its queue and copy slot. Both were found by
the live rebuild-fault suite (C15), which also covers a kill just before and
just after the commit write. A step that failed because either side reached
no daemon is reported as `daemon-unavailable` ("Docker stopped responding
while the environment's files were being copied"), not as files that failed
verification. A step that failed without saying so asks the daemon directly
(a bounded `docker version`), because a `docker cp` cut off mid-stream
reports its broken stream rather than the outage. Any other failure still
reads `needs-attention: … failed verification (<reason>)`. The wording is classified in one place
(`docker-cli-errors.ts`) for the copy steps, operation failure codes and the
availability check, and the image manifest probe applies the same strict
"could not find the file" rule, so a daemon lost between the probe's create
and its copy reads as unavailable (not cached) rather than as a legacy image.

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

### Capacity preflight

Before the source stops, a rebuild measures what it will copy and where it
will go, on the daemon's filesystem: bytes (estimate × 1.1 + 512 MiB
headroom) and, when the source is a volume set whose file count is known,
inodes (estimate × 1.1 + 10,000). Unknown byte capacity needs the user's
explicit confirmation; a legacy layer's file count is not measurable without
running it, so only its bytes are checked. A filesystem that still runs out
mid-copy (a quota Docker applies only on mount) fails the copy and rolls back
with the original authoritative — qualified live with tmpfs-backed volumes.

### Admission limits

The lifecycle queue serializes one environment's operations; across
environments `container-admission.ts` bounds the expensive ones. Four
container starts (through readiness) and two preserving rebuilds or
migrations run at once; further requests wait in arrival order, and one
beyond the wait bound (64 starts, 32 copies) is refused `resource-exhausted`
rather than queued without limit. A rebuild holds its prompt fence while it
waits for a slot.

### Pausing admissions

`ORKESTRATOR_CONTAINER_REPLACEMENT=paused` is the release safety switch: a
new rebuild or migration is refused (`capability-unavailable`) before anything
runs and the preview reports `admission-paused`. Recovery — listing, restoring
and discarding copies, reconciling an interrupted operation — is unaffected.

## Rollout switches and legacy runtimes

Persisted capabilities are the compatibility boundary: a runtime created from
an image without `persistent-workspace`, `staged-inputs` or `network-policy=2`,
or on an Engine older than 26, keeps the writable layer, host agent-home
mounts or the shared bridge that image expects. That is one lifecycle engine
branching on what the image declares, not a second one, and it is not
retired: an environment leaves it through a preserving rebuild, which always
uses the current image. No switch makes a capable image behave like an old
one any more.

| Switch | Status | Effect while set | Owner and removal |
| --- | --- | --- | --- |
| `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` | Permanent | New rebuilds and migrations refused; recovery unaffected | Container lifecycle. Kept: it only ever refuses new work |
| `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` | Removed 2026-10-25 | Ignored | It kept new runtimes on the writable layer as a fallback until volume storage passed on every platform; the rootless Linux run on 2026-10-25 was the last ([container qualification](../development/container-qualification.md#rootless-linux-host-2026-10-25)). A backend up to 2.30.0-beta still honours it and reports `disabled-by-configuration`, which the protocol and the rebuild section keep for that reason. `scripts/qualify-backend-upgrade-rollback.ts` sets it on its old release (v2.21.0) |
| `ORKESTRATOR_EGRESS=in-container` | Egress gateway rollout cap, not a legacy path | A gateway-capable image's restricted runtime keeps its firewall inside, with `NET_ADMIN`, where a root terminal can change it | Network isolation ([0018](../todo/containers-and-environments/0018-container-network-and-credential-isolation.md)). Remove once the gateway has been qualified on Linux Engine and rootless |
| `ORKESTRATOR_NETWORK_POLICY=2` | Policy 3 rollout cap, not a legacy path | A policy 3 image gets policy 2: every port of an allowed address stays open, still on the environment's own network | Network isolation ([0018](../todo/containers-and-environments/0018-container-network-and-credential-isolation.md)) |
| `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` | Removed 2026-10-25 | Ignored | It bound whole host agent homes read-only and put the Anthropic key in `docker inspect` |
| `ORKESTRATOR_NETWORK_POLICY=1` | Removed 2026-10-25 | Ignored; a capable image gets at least policy 2 | It joined the shared bridge, where the legacy firewall allows the whole gateway `/24`, siblings included. Exhausted address pools are fixed by widening Docker's `default-address-pools`, as the error says |

What still exists in the legacy shapes, and what handles it:

| Resource | Handled by |
| --- | --- |
| Current runtime on the writable layer | "Rebuild (keeps files)" or `orkestrator environment recreate` (a `migrate`); never migrated by a start, read or status refresh |
| Current runtime with host mounts or policy 1 (an older image, or created while a removed switch was set) | Kept until rebuilt; `get_environment_inputs` reports `host-mounts`, the network status reports the policy. Any rebuild creates the new runtime from the current image |
| Recovery copy of a legacy runtime | Listed, restored (swapped back as it was) and discarded like any copy; removed with the environment by the cleanup ledger |
| `legacy-unadopted` container (from before owner labels) | Offered for reattachment in the cleanup review, never removed by it |

There is no host-archive export. A runtime's data leaves the legacy shape only
as a verified copy into a new storage set on the same daemon, which then
gets recovery copies, verification and ledger deletion like any other.

### Design constraints

These held through the design and should keep holding:

- Always copy into a new storage set, including for a volume rebuild, so
  candidate setup can never damage the only pre-rebuild copy. The source is
  stopped, never restarted, to export it.
- One revision-checked write moves the runtime and storage pointers together
  and records the retained copies. Never revert automatically after the
  commit; prefer forward repair.
- Recovery copies have no age expiry; the cap blocks another rebuild rather
  than evicting a copy. Named volumes are persistence, not backup.
- Never mount all of `/home/node` or the host checkout to get persistence, and
  never symlink a state path: both weaken the credential destination checks.
  Credentials, configuration, caches and binaries stay in the container layer.
- SQLite stores are copied only with their writer stopped, with their `-wal`
  and `-shm` files. Dispatch journals stay beside their session identity, so
  an ambiguous dispatch survives reconstruction as unknown; resuming never
  manufactures a new turn.
- An interrupted copy discards the candidate and a retry recopies from
  scratch. A resumable copy journal was rejected: it would need partial-state
  verification across daemon restarts, the riskiest part of the copy path,
  and no measured workspace makes a recopy costly. Revisit only with one.
- Keep the identities distinct (`environmentId`, `runtimeGeneration`,
  `bootId`, `workspaceGeneration`, `storageSetId`, `operationId`, the lifecycle
  `revision`). Runtime generations only increase.
- Provider state is classified per path as preserve (needed to resume, rewind
  or fork, or a bridge map without which the host session id cannot be
  resolved), accept losing (user-visible, named in the limitation text, makes
  the provider `partial`) or drop (credentials, configuration, caches, logs,
  process registries, host-seeded content). A pinned-version test forces a
  re-trace on every agent bump
  ([upgrading agents](../development/upgrade-agents.md#re-trace-preserved-provider-state)).
- Scope: Docker CLI primitives behind a small backend service; no
  Kubernetes, no Docker SDK rewrite, no per-agent image matrix.

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
| `restore_recovery_copy` | Current runtime quiesced and kept as a `restore-source` copy in the same commit; a retained runtime still present is swapped back in, otherwise a new runtime mounts the verified set. Either way the restored runtime takes a new runtime generation (a swapped-back container keeps the generation label and name it was created with). Then the normal start path runs. |
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
outcome. The earlier one-shot `docker_system_prune` / `cleanup_orphaned_containers`
commands are refused (`invalid-request`): nothing is removed without a review.
A container from before owner labels is classified `legacy-unadopted` — it
could be any installation's on this daemon — and is offered for reattachment,
never removal.

## Portable inputs (`staged-inputs`)

A container created from an image that declares `staged-inputs` no longer
binds whole host agent homes. `portable-inputs.ts` copies the entrypoint's own
allowlist — for enabled providers only (narrowed to authorized credential
sources in agent-test profiles), plus Git identity — into a private revision
under `<data>/portable-inputs/<environment key>/`, and binds each staged
subtree read-only at the mount point the entrypoint already reads. The two
allowlists must stay in step; a unit test checks every staged target and file
name appears in `entrypoint.sh`.

Staged per provider (`portableInputSpec`):

| Provider | Mount | Staged |
| --- | --- | --- |
| Claude | `/claude-config`, `/claude-config.json` | `CLAUDE.md`, `settings.local.json`, `settings.json` filtered to its boolean `enabledPlugins` (no hooks, permissions or environment; withheld when it names no plugin), which the entrypoint merges into the container's own `settings.json` so the bridge and the CLI honour the host's plugin enablement, `.credentials.json` (access-only), `commands`, `skills`, `agents`, `ide`, `plugins`; `~/.claude.json` |
| OpenCode | `/opencode-config`, `/opencode-data`, `/opencode-state/model.json` | configuration (except `node_modules`); `auth.json` (access-only); `model.json`. Nothing else from the data directory: OpenCode 1.19.4 stores active console accounts and organizations in SQLite (preserved via `OPENCODE_DB`), not `account.json`. Host `snapshot/` is keyed by the worktree path; of `storage/` only the legacy-migration index is needed and an empty directory recreates it. The automated live data-contract suite runs authenticated active console accounts with and without these host files (`scripts/qualify-opencode-seeded-data.sh`) |
| Codex | `/codex-home` | `auth.json` (access-only), `config.toml`, `AGENTS.md`, `hooks.json`, `.codex-global-state.json`, model and cloud caches, `rules`, `skills`, `prompts`, `vendor_imports`, `plugins/cache` |
| Grok | `/grok-home`, `/grok-config` | `xai-api-key`, `auth.json` (access-only), `config.toml`, `trusted_folders.toml`, `agent_id`, `models_cache.json`, `hooks`, `skills`, `commands`; `~/.config/grok` |
| Pi | `/pi-config` | `agent/auth.json` (access-only), `models.json`, `settings.json`, `mcp.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills`, `prompts`, `extensions`, `themes` |
| Cursor (`staged-inputs=2`) | `/cursor-config` | `mcp.json` only, copied to `~/.cursor/mcp.json` mode `0600`; never account or login state, IDE state, hooks, plugins, extensions, `sdk/` or `cli-config.json` (the login arrives through the key sync) |
| Git | `/tmp/gitconfig` | `~/.gitconfig` (not in agent-test profiles) |

User-authored extension directories (Claude's `commands`, `skills`,
`agents`, `ide`, `plugins`; Grok's `hooks`, `skills`, `commands`; Pi's
`skills`, `prompts`, `extensions`, `themes`) are staged one top-level entry at
a time, so one skill directory is one unit. Input spec version 4 applies a conservative credential guard to the newly
added Claude `skills` and Grok `commands` trees. It withholds environment files,
credential/secret/token files, private-key files and common credential directories,
and files containing private-key blocks or credential assignments. Checks run on
the bounded bytes before writing any staged file; safe binary resources retain
their bytes. Withheld files count as `credential-withheld` without logging paths
or contents. This is defense in depth, not arbitrary-secret detection: keep
credentials outside extension bundles and supply required secrets explicitly
through the environment's credential configuration. No secret-file opt-in is
provided by staging. Older extension trees retain their existing policy.
A linked entry is skipped, like any link below a
home entry, so a skill `~/.claude/skills` links in from `~/.agents/skills` (an
`npx skills` install) is not staged and counts as `symlink`; `~/.agents/skills`
itself is not staged for any provider (todo
[2170](../todo/containers-and-environments/2170-shared-and-linked-skills-in-containers.md)).
Claude `skills` and Grok `commands` were added in input spec version 3; an
image built before then copies neither until the environment is rebuilt on a
newer image.

An image at `staged-inputs=1` has no `/cursor-config` copy, so its Cursor
sessions get no user MCP servers until the environment is rebuilt on a newer
image. Backend code that needs to know checks
`imageCopiesCursorMcpConfig` (`packages/protocol/src/image-manifest.ts`).

`staged-inputs=3` adds the rootless relay. A revision is owned by the
backend's user and owner-only; on a rootful daemon that user is the
container's `node` (UID 1000), but under rootless Docker it is container root
and `node` is a subordinate UID that cannot open the mounts. Before dropping
privileges, the root entrypoint (`relay_staged_inputs` in
`network-policy-entrypoint.sh`) checks each staged mount, and the project seed
binds `/project-env` and `/opencode-project-json`, as `node`. One `node`
cannot read in full is streamed with `tar`, root reading and `node` writing,
into `node`'s own `/run/orkestrator-inputs/<mount>` (`0700`/`0600`, links kept
as links, within the revision bounds). `entrypoint.sh` and
`workspace-setup.sh` read a relayed copy in place of its mount
(`staged_input_path`), and the Claude key file is read from either. Nothing is
widened on the host or for another user, and nothing is relayed on a rootful
daemon, where `node` reads the mounts directly. The relay is rebuilt from the
mounts on every boot, and revocation also removes the provider's relayed
copies from the running container (`stagedInputRelayPaths`). On a rootless
daemon an older image gets nothing readable: the backend logs it at creation
and the environment's inputs section says to rebuild (`unreadableOnRootless`,
`imageRelaysStagedInputs`).

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
- Logins whose refresh tokens are single-use or rotating are staged
  access-only: Codex and Grok `auth.json` keep the access token, the refresh
  token is blanked and an expired login is withheld (counted as
  `login-withheld`). A copy that refreshed would spend the token the host
  still holds and sign the host and every other container out. OpenCode's
  `auth.json` and Pi's `agent/auth.json` hold one login per model provider and
  are restricted per entry: API keys are kept, OAuth logins keep their access
  token with `refresh` blanked, and an expired one is dropped (also counted as
  `login-withheld`). GitHub Copilot (both) and Meta (Pi) reuse their refresh
  token rather than rotate it and are kept whole. All four are re-read from
  the host before every start. Grok's, OpenCode's and Pi's are also pushed
  before every bridge start, including a reused bridge, and whenever the
  host's file changes: `ContainerLoginFileWatcher` polls each file's inode,
  size and mtime every minute and pushes a changed one to every running
  container that may receive it, through the same bridge-operation queue and
  revocation fences (the writer-lease holder only). Pi and OpenCode re-read the
  file per request, so a running session picks a renewal up; whether Grok's
  agent re-reads it mid-session is not known. OpenCode and Pi merge
  the host's providers into the container's file, keeping a login made inside
  the container, and a host file of expired logins still blanks any refresh
  token the container holds for those providers. The entrypoint blanks the
  refresh tokens again in the container's own copy; for OpenCode and Pi only
  for providers the mounted host file holds as rotating OAuth, so a login
  made inside the container survives a restart.
- A host sign-out reaches the container. When the host has no Codex or Grok
  login at all (no `auth.json`, or one holding no login), the container's
  imported copy is removed: Codex at the next bridge start or terminal open
  (an idle bridge is stopped so it restarts without it), Grok at the next
  push. An imported login is recognised by its blank refresh token; a login
  made inside the container keeps its refresh token until the next restart and
  is kept, as is an API key. A host login that has only expired leaves the copy
  alone, since it has lapsed too. A container that used an added account
  already had its copy removed by the account switch path.
- When a container's host-imported Codex or Grok login lapses, the tab's
  sign-in message (readiness `authentication-required`) is replaced by
  guidance to renew the login on the host (or the added Codex account in
  Settings) and restart the environment (`containerSignInGuidance`), because
  a sign-in inside the container lasts only until the next restart. A
  container whose credentials for that provider are revoked keeps the bridge's
  own message.
- Claude's `.credentials.json` is access-only the same way
  (`restrictClaudeCredentialsSnapshot`): `claudeAiOauth` and every `mcpOAuth`
  entry lose `refreshToken` (the key is removed, because Claude Code treats an
  empty one as a dead login), and an expired subscription login is withheld
  (not reported as `login-withheld`: on macOS the on-disk file is often stale
  beside the Keychain login the stdin sync delivers).
  That applies to staging, the restage before every start, the stdin sync on
  every start and account switch, and a new push before every Claude bridge
  start. With nothing usable to push, the container's own copy has its refresh
  tokens stripped in place. The entrypoint strips a copy it takes from the
  `/claude-config` mount. A push merges rather than replaces
  (`buildMergeContainerClaudeCredentialCommand`): an `mcpOAuth` login the
  container made itself, holding a refresh token that is not one the host was
  seen to hold for that server (the push carries SHA-256 digests of the host's
  current and recently rotated MCP refresh tokens, never the tokens), is kept,
  so signing in to an MCP server inside the container lasts. A copy of a host
  token gives way to the host's access-only entry. The fallback strip with
  nothing usable to push, and the removal on an account sign-out, still take
  such a login too. The access token lasts about eight hours, so the
  backend's `ContainerClaudeLoginKeeper` re-reads the active login every five
  minutes, once per pass whatever the number of containers, and pushes it into
  each running container whose copy differs; the container CLI notices the new
  file by its mtime. Just before the token
  expires the keeper has the host's own CLI refresh it
  (`refreshHostClaudeLogin`: a `-p` request for a model no catalogue knows,
  with settings, tools, MCP and session persistence off), so the refresh runs
  through Claude Code's own lock and compare-and-swap save. A start or bridge
  start that finds the host token expired asks for that refresh at once
  rather than waiting for the next pass. An agent-test profile never
  refreshes the host. A switch also rewrites `oauthAccount` in
  the running container's `~/.claude.json`. Remaining qualification and renewal
  work is tracked in
  [0018-container-network-and-credential-isolation.md](../todo/containers-and-environments/0018-container-network-and-credential-isolation.md).
- Neither the Cursor key nor the Anthropic API key (when used instead of
  OAuth) is in a staged-inputs container's creation environment. The bridge
  reads the synced owner-only Cursor file. The Anthropic key is written to
  `/claude-config/.orkestrator-anthropic-key` in the staged revision, and
  `docker/runtime-env.sh` exports it into shells and agent processes, because
  Claude Code in terminals reads it from the process environment: it is
  visible to same-user processes, but not in `docker inspect`. Only a
  container of an image without staged inputs still gets
  `-e ANTHROPIC_API_KEY` (and `CURSOR_API_KEY`).
- Older images keep the read-only home mounts their entrypoint expects, and a
  running legacy container keeps them until it is rebuilt; `get_environment_inputs`
  reports that as `host-mounts`, never as narrowed.
- Credentials (staged inputs, the staged Anthropic key, or the creation
  environment of an image without staged inputs, the Cursor key and the
  start-time Claude credential sync) go only to
  providers that are enabled, authorized for agent-test profiles and not
  revoked for the environment (`providerCredentialsAllowed`).
- Enabling a provider later is a rebuild, reported as `missingProviders`.
  `revoke_provider_credentials` is durable: it records the provider in the
  environment's `revokedInputProviders` first (so no later staging or sync
  hands it back), empties the provider's staged subtrees in the revision the
  container binds (directories in place, bound files truncated so the mount
  sees it), removes the imported files from the running container and stops
  the provider's bridge, which restarts without them. `pendingRebuild` is set
  only when the container binds something the backend cannot empty (whole-home
  mounts of an older runtime). Terminals the user started may hold what they
  already read. `restore_provider_credentials` allows the provider again; its
  configuration returns with the next rebuild. Neither touches the host's
  credentials or revokes an account-wide key.
- Unreferenced input revisions are pruned only after 30 minutes, so a staging
  or container creation still in progress keeps its revision.

## Environment networks (`network-policy=2`)

A capable image's runtime joins its own bridge network
(`container-network.ts`): `ork-<owner>-<digest>-net`, labelled with owner,
environment and role, created before the container and adopted only with
exactly those labels. A creation failure is an explicit error (`resource-exhausted`
when Docker's address pools are full) and never falls back to the shared
bridge. The network asks for nothing about IPv6, so a daemon whose
`default-network-opts` enable IPv6 gives it an IPv6 subnet. The namespace
owner (the egress gateway, or the container itself) is created with
`net.ipv6.conf.all.disable_ipv6=1`, which leaves every interface, including
one attached later, without an IPv6 address; that was checked live on Engine
29.9.2 with IPv6 on by default (0018 task 3). The container also gets
three policy inputs the root bootstrap captures once, root-owned:

| File | Meaning |
| --- | --- |
| `/etc/orkestrator/network-policy` | `2` or `3` (absent means the legacy policy) |
| `/etc/orkestrator/host-service-ports` | Host TCP ports the workload may call (the agent-tools port) |
| `/etc/orkestrator/ingress-ports` | Container ports Docker publishes (bridges, entry and mapped ports) |

GitHub's published ranges come from a backend seed (`github-ranges-cache.ts`,
refreshed at most hourly and copied into the created container, or its egress
gateway, at `/etc/orkestrator-seed/github-ranges` with `docker cp` before the
first start) when it is under a day old, else a live
fetch cached in the container, else either copy under a week old; with none
the firewall fails closed. Reachability is verified against `github.com`, not
the rate-limited API. The report's `githubRanges` says which source applied.
The seed is copied rather than bound because a rootless daemon may be unable
to mount a read-only file bind from a `nosuid`/`nodev` filesystem; a file
bind already pinned the seed as it was at creation (the backend replaces it by
rename), so nothing is lost. A failed copy leaves the container to fetch the
ranges itself.

Every start of a runtime, rebuild candidate or egress gateway goes through
`startDockerContainer` (`container-start.ts`). A read-only bind Docker refuses
to remount (`remount-ro … operation not permitted`) becomes an
`unsupported-topology` error naming the source and target. Rootless dockerd
picks an automatic host port inside RootlessKit's namespace, which cannot see
host listeners, so RootlessKit's bind on the host can collide (`address
already in use`); when the colliding port is not one the user fixed, the
start is retried once. Docker 29.9 detaches the container from its network
on that failed start, and a bare retry ran it with no network and no published
ports, so the helper connects the container's own network again first and
stops it if the retry still has none. A second collision, or one on a fixed
port, is the existing `port-conflict`.

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

### Port and protocol tuples (`network-policy=3`)

A policy 3 container (the backend sends the newest policy the image declares;
`ORKESTRATOR_NETWORK_POLICY=2` caps it) keeps everything above and stores
address, protocol and port tuples in `allowed-domains` (`hash:net,port`,
matched `dst,dst`) instead of addresses:

- A bare domain is TCP 443. An entry naming a port, `host:port` (TCP) or
  `host:port/udp`, allows exactly that tuple; a domain is resolved once
  however many ports its entries name. The syntax is shared by the settings
  editors and the backend (`@orkestrator/protocol/network-allowlist`) and the
  container (`firewall-domains.sh`), which counts a malformed port with
  `invalidDomains`.
- GitHub's ranges are TCP 443 and 22; the metadata bootstrap is TCP 443.
- Host services, ingress and IPv6 are as in policy 2.
- A container on policy 1 or 2 is sent each entry's domain without its port,
  and the backend computes the configured `domainsRevision` over that list, so
  an old image never sees a port and keeps its every-port behaviour.

The environment's network status states which behaviour the container has.

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
  re-checked against the new set and rejected rather than continuing. A
  removed policy 3 tuple revokes only its own protocol and port. An address
  the kernel expired between refreshes counts as leaving: every application
  records the set's members (`/var/lib/orkestrator/allowed-entries`), and the
  next refresh revokes what that record has and the new set lacks, at most
  one refresh interval (30 minutes) after the expiry. New connections to it
  are refused from the moment it expires.
- **Edits.** `update-firewall.sh --set-domains <list>` (root, via `docker
  exec`) applies a list and then stores it in `/etc/orkestrator/allowed-domains`,
  so a restart boots with it; `--add`/`--remove` edit the stored list the same
  way. A list with characters outside a domain name (and, under policy 3, a
  port) is refused unchanged.

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

### Egress gateway (`egress-gateway=1`)

A restricted runtime whose image declares `egress-gateway=1` (and gets
network policy 2 or later) has its firewall enforced from outside it
(`egress-gateway.ts`). A companion container, `<runtime name>-egress`, owns
the network namespace, and the runtime joins it (`--network
container:<gateway id>`) with no added capability, so nothing in the runtime,
`orkroot` terminals included, can change the rules. Before this, the
firewall ran inside the runtime, which needed `NET_ADMIN`; that remains for
older images and under the `ORKESTRATOR_EGRESS=in-container` rollout cap.
The network status reports `enforcement` (`gateway`, `container`, `none`)
and the Network section says whether a root terminal can change the rules.

- **The gateway.** The same image (already local, with the same firewall
  scripts), run as root with `NET_ADMIN`, `--init`, a tmpfs `/run`, 128 MiB
  and 128 PIDs where the daemon enforces them, and the bounded log driver,
  through `/usr/local/bin/orkestrator-egress-gateway`: it records the policy
  (`network-policy-entrypoint.sh --record-only`), runs the unchanged
  `init-firewall.sh` (which starts the refresher) and idles. A failed or
  missing firewall leaves it running with `DROP` policies and a `failed`
  report. It holds everything that belongs to a namespace: the environment
  network, `net.ipv6.conf.all.disable_ipv6=1`, the published ports, the
  Linux Engine `host.docker.internal` alias (the runtime shares its
  `/etc/hosts` and `resolv.conf`), the GitHub seed (copied in) and the policy
  environment. It carries the owner label, role `egress-gateway`,
  `orkestrator-egress-environment` and `orkestrator-egress-workload` (the
  runtime's name), and neither the app label nor `environment-id`, so no
  listing of runtimes (cleanup review, usage, recovery copies, operation
  reconciliation) mistakes it for one. The runtime carries
  `orkestrator-egress-gateway` and `ORKESTRATOR_EGRESS=gateway`, which its
  root entrypoint records once with the rest of the policy.
- **Namespace owner.** Published ports, the firewall report, live edits,
  `--host-ports` and the network endpoint belong to the gateway.
  `container-network-owner.ts` resolves a runtime's owner from its
  immutable network mode (cached, and recorded when the backend creates the
  runtime, so its first start does not inspect it), and `getHostPort`, the network status,
  `applyEnvironmentAllowedDomains`, `ensureContainerHostServicePorts`, the
  Linux host alias repair and the preview resolver read through it.
- **Creation.** The gateway is created first, the runtime referencing it by
  id; a runtime create that certainly failed removes the gateway, an
  ambiguous one keeps it for reconciliation. A same-named gateway left by an
  interrupted attempt is replaced only when it is ours, for the same runtime,
  and that runtime does not exist.
- **Start.** `prepareEgressGatewayForStart` (in
  `startContainerWithAgentAccounts` and before a rebuild candidate's start)
  starts a stopped gateway and waits until its firewall reports `applied`;
  the tmpfs `/run` means an earlier boot's report cannot be read. Each read
  is one `docker exec` that waits inside the gateway, up to 2 s and checking
  every 50 ms, for the report to say `applied` or `failed`; the gateway is
  inspected only when that exec fails,
  and a running gateway's `applied` report is not read twice. A `failed`
  report, a gateway that stops, or 180 s without a report refuses the start
  (`not-ready`), and a missing gateway is `needs-attention` (rebuild). Docker
  itself refuses to start a runtime whose gateway is not running ("cannot
  join network namespace of a non running container"). A runtime still
  running in the namespace of a gateway that restarted since (its interface
  is gone, so it has only loopback and fails closed) is stopped and started
  again. Runtimes have no restart policy, so after a daemon restart Docker
  starts neither; the backend's start path keeps the order.
- **Boot verification.** The runtime's root entrypoint does not run the
  firewall; it connects to TEST-NET-1 (`192.0.2.1:443`) and requires the
  gateway's `icmp-admin-prohibited` rejection ("No route to host"). A
  timeout or success is `egress-unverified`, no route at all is
  `egress-gateway-unavailable`; both fail the boot.
- **Stop and removal.** `stopRuntimeContainer` stops the runtime, then its
  gateway, which frees fixed host ports for a rebuild candidate's gateway.
  `removeRuntimeContainer` removes a runtime and then its gateway (verified
  by owner and role) everywhere a runtime is removed: recreate, rollback,
  operation reconciliation, recovery copies, reviewed cleanup and an
  unpersisted create. The deletion ledger's `container` step also removes
  every gateway labelled for the environment before the `network` step, and
  startup removes gateways older than ten minutes whose runtime no longer
  exists (`sweepOrphanEgressGateways`). A recovery copy keeps its stopped
  gateway, so restoring it starts it the normal way.

The workload's own `NET_ADMIN` and the `init-firewall.sh` sudo grant are
gone: every image now runs the firewall step from the root entrypoint before
privileges drop, and an in-container runtime gets `NET_ADMIN` only for that
firewall. `no-new-privileges` stays off: the image's entrypoint is `sudo
network-policy-entrypoint.sh` as `node`, which it would break, and starting
runtimes as root instead would make every `docker exec` default to root.

## Agent tools reachability (`container-host-reachability.ts`)

Container agents reach the backend's agent tools server (workflow results,
mail, tickets) at `http://host.docker.internal:<port>/mcp`. A host firewall
that drops Docker traffic (ufw's default policy on many Linux desktops) makes
those calls hang: a review stage used to idle until its result poll gave up.
The server answers any non-POST with 405 before authenticating, so a
credential-free GET that gets *any* HTTP status proves the path; a timeout,
refusal or unresolved name proves it broken. Three checks share one probe
script and parser:

| When | From | Effect |
| --- | --- | --- |
| Backend startup (Linux, desktop and backend-only runs) | Throwaway containers of a pinned ~1 MB `busybox` image on the default bridge and on a temporary per-environment style network (both in parallel) | Publishes `container-host-reachability-changed`; the app shows a banner and a fix dialog |
| Bridge start (`resolveContainerAgentToolConnection`, Cursor/Grok/Pi starts) | `docker exec` in the environment container, after the host alias and network-policy repair | Logged; a result that contradicts the host verdict re-runs the host check (at most once a minute) |
| Before a tool-mode workflow stage dispatches (Multi Review, build pipeline, feature planning) | Same, cached 60 s for success and 10 s for failure | A proven block fails the stage at once with the cause and the fix; an inconclusive probe passes |

The startup check pulls busybox once (`--pull never` on every run afterwards)
and falls back to the environment image; with neither it reports
`unverified`, never a pass. It detects ufw (`/etc/ufw/ufw.conf`), firewalld,
nftables or iptables and builds fix commands for the actual port, scoped to
Docker's source addresses so the port stays closed to the local network.
Subnets in Docker's primary pool widen to it (for example
`sudo ufw allow proto tcp from 172.16.0.0/12 to any port <port>`) so new
environment networks are covered, unless one of the host's own non-Docker
interface addresses is in that pool; then, and for subnets in `192.168.0.0/16`
or `10.0.0.0/8` (common LAN ranges, never widened to), the rules name Docker's
exact subnets. Probe containers and the temporary network
carry the owner and `host-reachability-probe` role labels (not the `app`
label, so cleanup inventories never see them) and are removed after each
check; leftovers are reaped by the next one. Every step is logged with the
`[container-host-reachability]` prefix, one fixed-shape line per probe. The
probe URL carries no credential. Commands: `get_container_host_reachability`,
`check_container_host_reachability`.

On a rootless daemon (`dockerRootless`) `host-gateway` names a bridge inside
RootlessKit's network namespace, where nothing of the host listens. When
those probes do not all answer, the check probes again through RootlessKit's
host loopback address (`10.0.2.2`, `ROOTLESSKIT_HOST_LOOPBACK_ADDRESS`), which
the daemon refuses unless it runs with
`DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false`. If that answers,
the snapshot's `hostAddress` is set and new containers and gateways get
`--add-host host.docker.internal:10.0.2.2` (creation waits up to 45 s for the
first check, `resolveContainerHostAddress`), so the firewall's host-service
rule names it; the in-container alias repair before a bridge start uses it
too. If not, the verdict is `blocked` with a rootless remediation (a systemd
drop-in for the user's Docker service and its cost: a Docker restart, and
every container of that daemon reaching the host's loopback services)
instead of firewall rules, which cannot help. The environment settings
network pane shows "Agent tools unavailable" for a container environment
while the verdict is `blocked` (`EnvironmentAgentToolsStatus`). Existing
gateway runtimes snapshot their host address at gateway boot and need a
rebuild after host loopback is enabled.

## Resource budgets and usage (`container-resources.ts`)

A new runtime gets `environment.containerResourceLimits`, else
`global.containerResourceLimits` (Settings → Container), else the built-in
default for its daemon (`builtInResourceDefault`,
`packages/protocol/src/container-resources.ts`). A budget whose limits are
all `null` is an explicit opt-out ("No limits" in Settings, or blank fields
on an environment). The budget is resolved only when a runtime is created or
rebuilt, so an existing container keeps what it was created with until it is
rebuilt or updated on purpose; its resources panel shows the difference.
Settings writes the global budget only through `set_container_resource_limits`
(`setContainerResourceLimits`); `null` removes it and restores the built-in
default. A budget naming an axis this daemon cannot enforce
(`unenforceableAxes`) is still saved, since the default may be meant for
another daemon and an unreachable Docker must not block Settings, but the
command answers with that axis in `unenforceable`, and Settings warns while
the field is edited and again when it is saved: every create refuses such a
budget (below). The older `global.containerResources` slider value was never
applied and is no longer shown or read.

### Built-in default

| Axis | Default | Why |
| --- | --- | --- |
| `cpus` | none | CPU is compressible and Docker shares it fairly; a 2-CPU cap made the browser workload 1.4–1.75× slower on Desktop and builds 1.5× slower on Linux, and protects nothing memory and PID limits do not |
| `memoryMiB` | 8,192 MiB, capped at 75% of the daemon's memory (rounded down to 256 MiB; never below 512) | Above every measured workload's peak, and a small Docker Desktop VM keeps a quarter for the daemon and other containers. 5,888 MiB on Desktop's default 7.75 GiB VM, 8,192 MiB on a 32 GB Linux host; the preset when the daemon's memory is unknown |
| `pids` | 4,096 | About 10× the highest measured peak (392; threads count), far below a fork bomb |

`/dev/shm` stays 1 GiB under the default (half of any memory limit of at
least 2 GiB). The default contains a runaway environment — a leak or a fork
bomb is killed inside its own cgroup instead of exhausting the VM or host,
the backend and sibling environments; it is not a packing target, and the
sum over environments may exceed the daemon. The measurements behind it are
in [container-qualification.md](../development/container-qualification.md#workload-budgets).

An axis the daemon cannot enforce (support `false`, or unknown on a rootless
daemon) is left off the default and reported in the policy's `unsupported`
list and in Settings; the default is never refused, so a rootless daemon
without delegated controllers still creates runtimes, unrestricted. An
explicit budget on such a daemon is still refused, below. Docker Desktop
enforces all three axes inside its VM, whose size is the ceiling.
`get_docker_capacity` carries the default for that daemon as
`builtInDefault`; policies report its source as `default`. Older backends
omit both (and apply no default), which the Settings page shows.

| Axis | Docker | Bounds |
| --- | --- | --- |
| `cpus` | `--cpus` | 0.25–512 |
| `memoryMiB` | `--memory` and `--memory-swap` equal (no swap) | 512 MiB–4 TiB |
| `pids` | `--pids-limit` | 256–4,194,304 |

The applied value is always read back from `docker inspect`
(`HostConfig.NanoCpus`, `Memory`, `PidsLimit`) and reported separately from the
request, with axes the daemon says it cannot enforce. A daemon without cgroup
enforcement (rootless with cgroup driver `none`, or a controller that is not
delegated) accepts `--cpus`, `--memory` and `--pids-limit`, stores them and
enforces nothing, so the read-back alone would show them as applied. Every
create, `update_environment_resources` (stored or applied) and the rebuild
preflight therefore refuse an explicit (environment or Settings) budget axis
whose support `docker info` reports `false`, with `unsupported-topology`,
before anything is created or stopped. On a rootless daemon whose support is
unknown such a budget is refused as `daemon-unavailable`. The built-in
default drops those axes instead. `update_environment_resources`
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

### Unknown figures and out-of-memory kills

Usage figures Docker did not report are `null` end to end (memory, CPUs,
disk, image count, creation time) and Settings → Docker shows them as
unknown; it refreshes every five seconds while shown and marks a sample older
than fifteen seconds stale. `/dev/shm` is 1 GiB, or half the memory limit
when that is smaller, because shared memory is charged to the limit.
`container-oom-events.ts` follows Docker's `oom` events for this owner — a
killed child process leaves `State.OOMKilled` false — replaying from its last
event after a restart without double-counting; samples carry `oomEvents`
(null while not following). The same follower reports `start`, `die`, `stop` and
`destroy`, which invalidate the shared `docker ps` snapshot so status reads do
not keep answering for a container that just ended. A memory update below current use is refused
`confirmation-required` until the user confirms it.

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
SIGPIPEs its producer, even when it cannot open or write the file. Each line
is written as it arrives. The writer is one Perl process (perl-base is
Essential on Debian): an earlier `stdbuf fold | awk` pipeline lost lines to
each tool's own pipe buffering. The image's mawk block-buffers a piped stdin
unless run with `-W interactive`, so until 2026-10-26 a quiet, long-lived
bridge (most print nothing until a turn runs with debug logging on) had no log
file at all and the last few KiB of a noisy one, the lines a failure diagnosis
needs, were held back; Rust coreutils' `fold` (Ubuntu 26.04) buffers its
output whatever `stdbuf` asks, and mawk exited when the file could not be
opened. Only a line still waiting for its newline is held, and at most 64 KiB
of it before it is split, so output without newlines stays bounded. An image
built before the rewrite keeps the old behaviour until it is rebuilt.

`open_container_logs` / `read_container_logs` / `close_container_logs` share
one `docker logs -f` per container among subscribers; a read renews the lease,
a cursor older than the ring or from another source returns an explicit `gap`,
and a replaced runtime is a new source id. Closing releases only the observer.
The legacy `stream_container_logs` is an adapter onto the same service whose
lease lapses, so an old client that never closes cannot leave an immortal
follower. Backend shutdown stops every follower.

## Claude terminal state signal (`claude-state-signal=2`)

Claude started in a container terminal reports its state through the hooks the
entrypoint writes into `~/.claude/settings.json`: `UserPromptSubmit` writes
`working` and `Stop` writes `waiting` to `/tmp/.claude-state`. A turn that ends on
an API error runs `StopFailure` instead of `Stop`, which is not installed here, so
it reads `working` until the next prompt (to-do 1200). Bridge sessions
(`ORKESTRATOR_NATIVE_AGENT_BRIDGE` set) write nothing. The same file sets
bypass permissions as the default mode and records its consent
(`skipDangerousModePermissionPrompt`), the only place current Claude Code
reads it, so a **Claude CLI** tab opens straight to the prompt on every start;
the image also sets `DISABLE_AUTOUPDATER=1` and `FORCE_AUTOUPDATE_PLUGINS=1`,
so the pinned CLI never replaces itself in the container. `ClaudeStatePollManager`
(`tmux-poll.ts`) reads the file with one `docker exec` and persists and emits
`claude-state-<containerId>` only on change.

Version 2 hooks call `orkestrator-state-signal working|waiting`, which serializes
writers with a bounded file lock and atomically replaces `/tmp/.claude-state-snapshot`
with `state revision completions`. The counters survive lost POSTs, including a
whole working-to-waiting turn between reads. The legacy state file is still
written for older backends. Reads are bounded to 256 bytes. Version 1 images
keep the one-second poll because their state cannot expose a missed whole turn.

After persisting, `orkestrator-state-signal` POSTs, detached and with no body,
to `/claude-state-signal` on the agent
tools server. The request only says "read now"; the backend reads the file
itself, so a late or reordered request can never report a stale value.

| Step | What happens | Where |
| --- | --- | --- |
| Arm | Once per poll lineage, if the image's manifest declares the capability: issue a doorbell credential, prepare the host alias and service port as a bridge start does, write the curl config to `/tmp/.orkestrator-claude-state-signal` (0600, from stdin, never argv), then ring once | `claude-state-signal.ts` |
| Confirm | Until that probe ring arrives, the poll stays at 1 s. A ring plus a valid counter snapshot moves it to a 30 s safety read | `CLAUDE_STATE_SAFETY_READ_INTERVAL_MS` |
| Ring | Each doorbell requests one read, coalesced behind any read in flight | `ClaudeStatePollManager.ring` |
| Miss | A safety read that finds a state or revision change with no ring since the previous read began revokes the credential and returns to 1 s | `demoteSignal` |
| Flood | More than 30 rings in a minute does the same, so a container can never cause more reads than the 1 s poll | `CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE` |
| Retry | Arming is attempted at most every 5 min per container; a legacy or invalid manifest is never asked again, an unreadable one or missing runtime image identity is | `CLAUDE_STATE_SIGNAL_RETRY_MS` |
| Retire | Shutdown and retirement revoke the credential; installs are serialized across poll lineages, and retired installs are fenced before publishing config; a backend restart forgets all of them | `AgentToolsServer.issueStateSignal` |

A doorbell credential opens nothing else: `/mcp` refuses it and MCP tokens are
refused on the doorbell. Images without the capability, contexts without the
agent tools server, and unit tests (`NODE_ENV=test`) keep the 1 s poll.

Failed reads and rejected persistence retry at one-second cadence without
counting the failed observation as a missed signal. Only accepted observations
advance the counters. A recovered completion restores the durable completion
token and unread badge when storage missed the working edge, and triggers the armed PR refresh and
the one-shot agent-created PR probe once, even if the final state is unchanged.

A container where terminal Claude has never run has neither state file. The
read then prints a framed `absent` marker (`CLAUDE_STATE_ABSENT_MARKER`),
which counts as a successful observation at revision 0 with no completions:
it emits and persists nothing, but a confirmed doorbell keeps the 30 s safety
read, and a first turn missed between two reads is still recovered from the
counters. It still counts towards stale marking after three reads, as before.
Without this, every container that never ran terminal Claude stayed on the
1 s poll with a confirmed doorbell (seen in a 2026-10-24 profile run).

`ClaudeStatePollManager.status()` reports the signal's health, per state
(`unarmed`, `arming`, `armed`, `confirmed`, `demoted`, `unsupported`), how
many containers run the 1 s poll (`fallback`), lifetime demotions by reason
(`missed-change`, `rang-too-often`, `arm-failed`) and accepted rings, in the
`signals` block of recurring diagnostics (`claude-state-signal`). It is
content-free: no container id. The demotion log line still names the
container.

## Container worktree signal (`container-worktree-signal=1`)

A container's Files panel and diff counts have no host-side watcher. Without
a signal, every panel read past 3 s costs a status exec, the tree re-walks
every 10 s while the panel is open, and the counts rescan every 15 s. With
the signal, `DiffStatsService` treats the container like a watched local
worktree: results stay valid until a ring, a known mutation or an explicit
refresh, and only a 60 s safety scan runs
(`CONTAINER_SAFETY_NET_INTERVAL_MS`).

`orkestrator-worktree-signal` (`docker/orkestrator-worktree-signal.sh`) runs
`inotifywait --monitor --recursive` over `/workspace` as `node`, in its own
session. It ignores `node_modules` (the tree skips it and its watch count is
unbounded), Git's object store, logs and transient `.git/**/*.lock` files;
project dependency lockfiles, `.git/index`, `HEAD`, `refs` and `packed-refs`
are watched. Modify events announce writes even while a file descriptor stays
open. A burst of events becomes one ring after 300 ms of quiet or 1 s from
its start, with at least 1 s between change rings and a trailing notification. Rings carry no paths or content, only
a reason header that can add work but never remove it: `ready` once the
watches are established, `change`, `overflow` (an inotify queue overflow) and
`lost` when `inotifywait` exits by itself (a watch or instance limit, the root
removed). The container status scan runs with `GIT_OPTIONAL_LOCKS=0` and
`diff.autoRefreshIndex=false`, as the local scan does, so a scan never writes
the index and rings for itself; stat-only modifications are filtered with
numstat.

| Step | What happens | Where |
| --- | --- | --- |
| Lineage | `DiffStatsService` starts one watcher per tracking lineage (a container start, a retarget, a resume after a pause, a backend start, a replacement container) through `startContainerWatcher`; a pause, untrack or retarget closes it, aborts in-flight host preparation or installation and revokes its credential | `DiffStatsService.attachContainerWatcher` |
| Arm | If the image declares the capability: issue a credential for `/worktree-signal`, prepare the host alias and service port, then `docker exec -i --user node <id> orkestrator-worktree-signal start` with the curl config on stdin (0600, never argv). The script stops a previous lineage's watcher (pid file plus `/proc/<pid>/cmdline` check, since `/tmp` survives a restart) and starts a new one. Installs are serialized per container | `container-worktree-signal-install.ts` |
| Confirm | Until the `ready` ring arrives the entry keeps the unwatched bounds. The ring marks it qualified and rescans both views once, because nothing before it was announced | `ContainerWorktreeSignals.ring` |
| Ring | Each ring hints the file list and the tree, forwarded at most once per 2 s (trailing), so constant writes cost at most one status exec per 2 s | `CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS` |
| Miss | A safety scan whose list changed although nothing advanced the entry's epoch from the previous scan through this scan's completion reports `unannouncedChange`; unless a ring arrives within 3 s (one still settling in the container) the lineage is demoted | `CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS` |
| Lost, flood | A `lost` ring, or more than 120 rings a minute, demotes at once and rescans | `CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE` |
| Retry | A demoted lineage, a failed install, an install whose `ready` ring never arrived, an uninspectable image and an unavailable agent-tools issuer re-arm 5 min after the last attempt; an image without the capability is never asked again for that container | `CONTAINER_WORKTREE_SIGNAL_RETRY_MS` |

The credential rings only `/worktree-signal`; a Claude state credential is
refused there and a worktree credential on `/claude-state-signal`. Neither
opens `/mcp`. A container restarted without the backend seeing it stop loses
its watcher silently; the next safety scan finds anything that changed
meanwhile and demotes it. Unit tests (`NODE_ENV=test`) and images without the
capability keep the 3 s, 10 s and 15 s bounds. The health of every lineage is
in the `signals` block of recurring diagnostics (`container-worktree-signal`),
with demotion reasons `missed-change`, `rang-too-often`, `arm-failed` and
`watcher-lost`.

Measured on Docker Desktop 29.7.2 (Apple M5 Max, 2026-10-24, this
repository's HEAD as the workspace, 513 watches): the watcher's three
processes use 7 MB RSS and no CPU while idle, set up in 254 ms, and the kernel
holds about 0.5 MB for the watches. One tree walk costs about 130 ms of VM CPU
and one status scan about 150 ms, plus about 19 ms in the host `docker` CLI
each. A file change reaches a completed scan in about 0.45 s.
