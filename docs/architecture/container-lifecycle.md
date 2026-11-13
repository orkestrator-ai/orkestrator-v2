# Container lifecycle

Living guide to how the backend owns environment containers. Qualifying a
change against a real daemon is in
[container-qualification.md](../development/container-qualification.md);
outstanding work is in `docs/todo/containers-and-environments/`
([index](../todo/containers-and-environments/0000-index.md)).

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
remediation text.

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
Rootless daemons are supported with gated features and were qualified on a
Linux host (RootlessKit with slirp4netns) on 2026-10-26 and again on
2026-11-09 with an image built from `main`; the gaps those runs left were
7548 (host loopback on the gvisor-tap-vsock driver, fixed and retired on
2026-11-10; [evidence](../development/container-qualification.md#gvisor-tap-vsock-host-loopback-7548)) and
[7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md)
(`docker cp` refusals and a second port collision). A resource budget axis the daemon reports it cannot enforce is
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

## Terminal close

A container terminal is a host `docker exec -it` client, and Docker does not
end an exec when its client goes away. So each terminal shell is started with
a token in `ORKESTRATOR_TERMINAL_SESSION`: a process-wide backend instance UUID,
`--`, and a fresh shell UUID (one per PTY lifetime, never reused by a stable tab's next shell) and records its PID and session ID as
`/tmp/orkestrator-terminals-<uid>/<token>.pid`
(`CONTAINER_TERMINAL_PID_RECORD_COMMAND`). Whenever the PTY goes away, closed
by the user, superseded, reaped as an orphan or exited, the backend runs
`CONTAINER_TERMINAL_CLOSE_SCRIPT` in the container as the terminal's own user
(`container-terminal-shell.ts`). The script removes the record, sends SIGHUP to
the recorded shell's process group once `/proc/<pid>/environ` proves the PID
still carries the token, then to other processes carrying it in the recorded session, because zsh
gives each job its own process group. Detached sessions (including tmux) survive;
a missing session identity skips the scan. A program that ignores SIGHUP (`nohup`)
survives, as it would a closed terminal. Each shell start sweeps its uid's
records whose PID no longer carries its token, and the entrypoint removes
`node`'s records at every container start. A container an explicit stop is
draining gets no close exec, since the drain hangs up terminal shells itself.
A close while the container is stopped or unreachable signals nothing. A backend
exit can leave its shells alive, but each new shell start closes this uid's
records from other backend instances through the same close script. Legacy
unprefixed tokens also count as orphans; the current instance's shells are kept.
Consequently a long job left running in an orphaned tab now ends at the next
terminal start for its uid, rather than waiting for the container to stop.
Detached sessions and programs ignoring SIGHUP retain the close semantics above.

## Stop and drain

An image with the `graceful-shutdown` capability runs under Docker's `--init`
(signal forwarding, orphan reaping). An explicit stop:

1. persists the `draining` phase and fences new bridges, terminals and setup
   for that environment;
2. runs `/usr/local/bin/orkestrator-drain.sh` as root, which sends SIGTERM to
   every workload process except PID 1 and the recorded keepalive and waits up
   to 10 s for those that can act on it, resuming stopped jobs with SIGCONT.
   Processes ignoring SIGTERM are normally not waited for. When it has a controlling terminal, as the interactive shells
   of the setup terminal and terminal tabs do, it gets SIGHUP once the others
   have gone, the way a closed terminal would hang it up. Finally, pipe readers
   (including EOF-driven log writers that ignore both TERM and HUP) are waited
   for within the same deadline so final output is flushed before teardown;
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
  OpenCode 2.x always gets a database of its own, `opencode2.db`: on the same
  mount beside 1.x's when it is present, otherwise in the container layer,
  never 1.x's `opencode.db`, which 2.x would migrate in place.
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
2.1.319, Codex 0.167.0, OpenCode 2.2.6, Pi 1.5.0, `@cursor/sdk` 1.3.1, Grok
1.0.77), by reading the pinned binaries' strings and bundled docs. A pin bump
fails `apps/backend/tests/container-state-layout.test.ts` until the layout is
re-traced ([upgrading agents](../development/upgrade-agents.md#re-trace-preserved-provider-state)).
OpenCode's CLI is the toolchain's `opencode2` (OpenCode 2.x), whose sessions
are in `OPENCODE_DB` (`opencode2.db` and its WAL and SHM files) in the
`opencode/db` sub-directory, so it needed no mount of its own and a storage
set initialized before it existed mounts unchanged. The `opencode.db` that
OpenCode 1.x left there is no longer read or copied by a rebuild.

| Provider | Preserved (`state` sub-directory → mount) | Not preserved |
| --- | --- | --- |
| Claude | `claude/projects` → `~/.claude/projects` (SDK transcripts); `claude/file-history` → `~/.claude/file-history` (rewind); `claude/orkestrator` → `~/.claude/orkestrator` (bridge dispatch and steer journals, preferences) | `.credentials.json`, settings, `commands`/`skills`/`agents`/`plugins`, caches, `~/.claude.json` |
| Codex | `codex/sessions`, `codex/archived_sessions` (rollouts, fork lineage); `codex/orkestrator-bridge` (session map, dispatch journal, the title index that keeps names set in Orkestrator); `codex/sqlite` at `CODEX_SQLITE_HOME` (every `*_N.sqlite` runtime database: state, thread history, goals, queue, memories, logs) | `session_index.jsonl` (Codex's own thread names, at the home root; only a name set in the Codex CLI itself is lost), `history.jsonl` (prompt recall), `shell_snapshots`, `auth.json`, `config.toml`, caches |
| OpenCode | `opencode/db` via `OPENCODE_DB` (session database: sessions, messages, parts, todos, permissions, console accounts and selected organization; 2.x keeps its own `opencode2.db` there, with its sessions, credentials imported from `auth.json` on its first start, and key-value cache) | `snapshot/` (revert and diff git directory, recreated on demand), `tool-output/` (full copies of truncated tool output), `storage/` (the legacy-migration index and each session's saved change list, `session_diff/`), the TUI state under `~/.local/state/opencode`, `auth.json`, configuration, plugins, mise installs under `~/.local/share` |
| Pi | `pi/sessions` → `~/.pi/agent/sessions` (`PI_SESSION_DIR`); `pi/bridge-state` → `/tmp/orkestrator-pi-state` | `auth.json`, `models.json`, settings, extensions, themes |
| Cursor | `cursor/bridge-state` → `/tmp/orkestrator-cursor-sdk-state` (SDK agent store and bridge journals) | `/tmp/orkestrator-ai/cursor-sdk-auth.json`, API-key files, `~/.cursor/mcp.json` (a staged input: snapshotted at creation, brought back in step on every start), other `~/.cursor` auxiliaries |
| Grok | `grok/sessions` → `~/.grok/sessions` (per-cwd session directories, which hold everything `session/load` reads, and the rebuildable search index); `grok/bridge-state` → `/tmp/orkestrator-acp-state` | `active_sessions.json` (live-process registry), `worktrees.db` (registry of Grok's own worktrees, which live outside the preserved set), opt-in `memory-v2/`, `auth.json`, configuration |

Provider MCP configuration is never preserved in the container: on every boot
the entrypoint makes it match the staged inputs again
([Input stamps](#input-stamps-staged-inputs5)). A container
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
databases (`~/.codex/*.sqlite*`) and OpenCode's `opencode2.db*` are relocated
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
than leaving the rebuild holding its queue and copy slot. Once the producer
has closed, the helper gets a drain window (`copyDrainWindowMs`: 2 minutes
plus 1 s per 16 MiB sent, plus as long again as the stream took, so a loaded
host that slows the helper's final verification has also slowed the stream
and earned the time) to finish; a helper still running then is killed,
its container removed by name, and the step fails as `helper-input-stalled`
(logged `replacement.copy-helper-stalled`), because on a rootless daemon a
helper once never saw end of input and would otherwise have held the
rebuild for the one-hour copy deadline
([7705](../todo/containers-and-environments/7705-rootless-copy-stream-stdin-never-closes.md)).
The step settles only after that removal has finished, because rollback
removes the candidate's volumes next and Docker keeps a volume a container
still mounts; a helper that could not be removed fails the step as
`helper-remove-failed` (logged `replacement.copy-helper-remove-failed`). A
producer that had already failed with its own answer (nothing to copy, a
refused remount, no daemon) is classified by that answer, not as a stall of
the helper it left waiting. The absent-path rule and the output discard were found by
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
mounts or the shared bridge that image expected. That is one lifecycle engine
branching on what the image declares, not a second one, and it is not
retired: an environment leaves it through a preserving rebuild, which always
uses the current image. No switch makes a capable image behave like an old
one any more.

No new container gets host agent-home mounts. Creating one from an image that
does not declare `staged-inputs` is refused with `capability-unavailable`
before anything is created, whichever path asked (a create, a rebuild's
candidate or a restore that needs a new runtime), and the message names the
image and asks for a current one. A failed start persists that same message.
An image whose manifest Docker cannot read is not called old: the create
reports `daemon-unavailable` and creates nothing. `get_docker_image_status`
requires the capability too, so Settings reports such an image as incompatible
and offers the download. A custom image has to be rebuilt from the current
Dockerfile. A runtime that already exists is never refused for this: a start
or a read does not reach the create, so it keeps running with its mounts until
the user rebuilds it.

| Switch | Status | Effect while set | Owner and removal |
| --- | --- | --- | --- |
| `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` | Permanent | New rebuilds and migrations refused; recovery unaffected | Container lifecycle. Kept: it only ever refuses new work |
| `ORKESTRATOR_CONTAINER_STORAGE=legacy-layer` | Removed 2026-10-25 | Ignored | It kept new runtimes on the writable layer as a fallback until volume storage passed on every platform; the rootless Linux run on 2026-10-25 was the last ([container qualification](../development/container-qualification.md#rootless-linux-host-2026-10-25)). A backend up to 2.30.0-beta still honours it and reports `disabled-by-configuration`, which the protocol and the rebuild section keep for that reason. `scripts/qualify-backend-upgrade-rollback.ts` sets it on its old release (v2.21.0) |
| `ORKESTRATOR_EGRESS=in-container` | Removed 2026-11-04 | Ignored; a gateway-capable image's restricted runtime always gets a gateway | It kept the firewall inside the runtime, with `NET_ADMIN`, where a root terminal can change it. There is no longer a switch back if the gateway fails on a host. Its Linux Engine and rootless qualification is summarised in [container qualification](../development/container-qualification.md#egress-gateway-on-linux-engine-qualification-closed-2026-11-11); what is still unproved on rootless is [7390](../todo/containers-and-environments/7390-rootless-restart-remaining-settings.md). The runtime's own `ORKESTRATOR_EGRESS=gateway` value, which its root entrypoint records, is a different thing and stays |
| `ORKESTRATOR_NETWORK_POLICY=2` | Policy 3 rollout cap, not a legacy path | A policy 3 image gets policy 2: every port of an allowed address stays open, still on the environment's own network | Network isolation ([environment networks](#environment-networks-network-policy2)) |
| `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` | Removed 2026-10-25 | Ignored | It bound whole host agent homes read-only and put the Anthropic key in `docker inspect` |
| `ORKESTRATOR_NETWORK_POLICY=1` | Removed 2026-10-25 | Ignored; a capable image gets at least policy 2 | It joined the shared bridge, where the legacy firewall allows the whole gateway `/24`, siblings included. Exhausted address pools are fixed by widening Docker's `default-address-pools`, as the error says |

What still exists in the legacy shapes, and what handles it:

| Resource | Handled by |
| --- | --- |
| Current runtime on the writable layer | "Rebuild (keeps files)" or `orkestrator environment recreate` (a `migrate`); never migrated by a start, read or status refresh |
| Current runtime with host mounts or policy 1 | Kept until rebuilt, and listed in the cleanup review with a Rebuild action per environment. `get_environment_inputs` reports `host-mounts`, the network status reports the policy. Any rebuild creates the new runtime from the current image, and creating one from an image without `staged-inputs` is refused |
| Current runtime with an in-container firewall (an older image, or created while a removed switch was set) | Kept until rebuilt; the network status reports `enforcement`. Any rebuild creates the new runtime from the current image |
| Recovery copy of a legacy runtime | Listed, restored (swapped back as it was) and discarded like any copy; removed with the environment by the cleanup ledger |
| `legacy-unadopted` container (from before owner labels) | Offered for reattachment in the cleanup review, never removed by it |

The cleanup review's list (`legacyRuntimes` on `docker_cleanup_preview`) reads
each assigned container with `docker inspect` when the review opens. A runtime
counts as having host mounts when it has no inputs-revision label and binds one
of the mount points the old images read; staged inputs bind the same mount
points, which is why the label decides. A runtime with no network-policy label
is on policy 1. A container Docker did not answer for is counted in
`legacyRuntimesUnchecked` and the review says so, rather than reading silence
as nothing to rebuild. The list never joins the removal selection: its only
action is the preserving rebuild, confirmed through the same dialog as the
environment's own Container settings, on the machine the review is for. An
environment with a container operation running shows as busy until it ends.

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
outcome. Nothing is removed without a review: the earlier one-shot prune and
orphan-cleanup commands were removed on 2026-11-10.
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
| Claude | `/claude-config`, `/claude-config.json` | `CLAUDE.md`, `settings.local.json`, `settings.json` filtered to its boolean `enabledPlugins` (no hooks, permissions or environment; withheld when it names no plugin), which the entrypoint merges into the container's own `settings.json` so the bridge and the CLI honour the host's plugin enablement, `.credentials.json` (access-only), `commands`, `skills`, `agents`, `ide`, `plugins`; `~/.claude.json` filtered to `oauthAccount`, the onboarding flags and container-safe user `mcpServers` (`claudeContainerConfig`: no `orkestrator` entry, no loopback URL, nothing naming a path in the host home; no projects, history, caches or API key), with the same top-level allowlist applied again by the entrypoint |
| OpenCode | `/opencode-config`, `/opencode-data`, `/opencode-state/model.json` | configuration (except `node_modules`); `auth.json` (access-only); `model.json`. Nothing else from the data directory: OpenCode 1.19.4 stores active console accounts and organizations in SQLite (preserved via `OPENCODE_DB`), not `account.json`. Host `snapshot/` is keyed by the worktree path; of `storage/` only the legacy-migration index is needed and an empty directory recreates it. The live check that showed it ran against OpenCode 1.x and was retired with it (`git show 5f4e27b1c:scripts/qualify-opencode-seeded-data.sh`) |
| Codex | `/codex-home` | `auth.json` (access-only), `config.toml`, `AGENTS.md`, `hooks.json`, `.codex-global-state.json`, model and cloud caches, `rules`, `skills`, `prompts`, `vendor_imports`, `plugins/cache` |
| Grok | `/grok-home`, `/grok-config` | `xai-api-key`, `auth.json` (access-only), `config.toml`, `trusted_folders.toml`, `agent_id`, `models_cache.json`, `hooks`, `skills`, `commands`; `~/.config/grok` |
| Pi | `/pi-config` | `agent/auth.json` (access-only), `models.json`, `settings.json`, `mcp.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `skills`, `prompts`, `extensions`, `themes` |
| Cursor (`staged-inputs=2`) | `/cursor-config` | `mcp.json` only, copied to `~/.cursor/mcp.json` mode `0600`; never account or login state, IDE state, hooks, plugins, extensions, `sdk/` or `cli-config.json` (the login arrives through the key sync) |
| Shared skills (`staged-inputs=4`) | `/agents-skills` | `~/.agents/skills`, one unit per top-level entry with the credential guard, copied to `~/.agents/skills`. Staged once, as the `shared-skills` summary entry, when Codex, Cursor, Grok, OpenCode or Pi is staged (`SHARED_SKILL_READERS`; Claude does not read it). It holds no login, so it has no revoke action |
| Git | `/tmp/gitconfig` | `~/.gitconfig` (not in agent-test profiles) |

The entrypoint rebuilds `~/.claude.json` on every boot, from the staged host
file through `CLAUDE_JSON_ALLOWED_KEYS` or from a minimal fallback, so any
answer Claude Code wrote there in the container is gone at the next start.
Every path therefore sets `bypassPermissionsModeAccepted`,
`hasCompletedOnboarding` and `hasSeenAutoDefaultNudge` itself; without the
last, terminal Claude asks "Make auto mode your default permission mode?" in
every Claude CLI tab after each start (`tests/unit/container-claude-settings.test.ts`
pins it). The key is Claude Code's internal state, so a release that renames it
brings the offer back.

User-authored extension directories (Claude's `commands`, `skills`,
`agents`, `ide`, `plugins`; Grok's `hooks`, `skills`, `commands`; Pi's
`skills`, `prompts`, `extensions`, `themes`) are staged one top-level entry at
a time, so one skill directory is one unit. A unit is all-or-nothing, with
one exception (input spec version 7): inside an entry of a skill root, a file
over the per-file bound is left out and counted as `too-large`, and the rest
of the skill is staged. Skills ship platform binaries (Impeccable carries a
17 MB macOS executable beside a launcher that downloads the Linux one), and
dropping the whole skill for a file the container cannot run left the agent
without it. A skill whose own `SKILL.md` is over the bound is still refused
whole. The skips of files left out of a unit (links, withheld files, a
skill's oversized files) are counted only once the unit is staged, so a unit
refused whole counts as that one refusal. Input spec version 4 applies a conservative credential guard to the newly
added Claude `skills` and Grok `commands` trees. It withholds environment files,
credential/secret/token files, private-key files and common credential directories,
and files containing private-key blocks or credential assignments. Since input
spec version 7 an assignment counts only when its value looks generated: eight
or more characters with both a letter and a digit, not a `${VAR}`, `%VAR%` or
`<placeholder>`, not spelled with a placeholder word (`your`, `example`,
`secret`, `password`, …), and read only up to a bracket. Every assignment in a
file is checked, not just the first, and a value never starts on the next
line: an empty `API_KEY=` does not take the following `CLIENT_SECRET=…` as
its value, and an assignment that appears inside another's value is checked
on its own. Before that, documentation such as
`export CONTEXT7_API_KEY=your_key`, `"total_tokens": 1234` or
`tokens=1-3` withheld the `SKILL.md` that defines the skill. Checks run on
the bounded bytes before writing any staged file; safe binary resources retain
their bytes. Withheld files count as `credential-withheld` without logging paths
or contents. This is defense in depth, not arbitrary-secret detection: keep
credentials outside extension bundles and supply required secrets explicitly
through the environment's credential configuration. No secret-file opt-in is
provided by staging. Older extension trees retain their existing policy.
A linked entry is skipped, like any link below a home entry, with one
exception (input spec version 5):
a top-level entry of a skill root (Claude's, Codex's, Grok's and Pi's `skills`, and
`~/.agents/skills`) that links to a skill. It is staged as a real directory
when its resolved target is a directory holding a regular `SKILL.md`, strictly
inside `~/.agents/skills` or a skill root of a provider staged in the same
run (Codex's `skills` included), with no link between that root and the
skill. A skill root that resolves to `/`, a home or an ancestor of one is
never an allowed target. Links inside the skill are still skipped, the
credential guard always applies to the copy, and the target's identity is
checked again after copying, so a directory swapped in mid-copy is discarded
(`changed-while-reading`). Every other link counts as `symlink`. This covers
the `npx skills` layout, where `~/.claude/skills/<name>` links to
`~/.agents/skills/<name>`. Codex skills also copy per entry so rejected or
oversized skills do not discard siblings. The shared source itself uses the
same home/root refusal, and linked source ancestry is credential-checked
before copying under an alias.
Claude `skills` and Grok `commands` were added in input spec version 3; an
image built before then copies neither until the environment is rebuilt on a
newer image. `/agents-skills` needs `staged-inputs=4`: the backend stages it
only for an image whose entrypoint copies it (`imageCopiesSharedSkills`).

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
paths `/project-env` and `/opencode-project-json` (bind mounts before H3,
copied in since; see [Project seed files](#project-seed-files)), as `node`. One `node`
cannot read in full is streamed with `tar`, root reading and `node` writing,
into `node`'s own `/run/orkestrator-inputs/<mount>` (`0700`/`0600`, links kept
as links, within the revision bounds). `entrypoint.sh` and
`workspace-setup.sh` read a relayed copy in place of its mount
(`staged_input_path`), and the Claude key file is read from either. Nothing is
widened on the host or for another user, and nothing is relayed on a rootful
daemon, where `node` reads the mounts directly. Each boot checks the copies
against the mounts: root keeps a digest of every mount it relayed (paths,
types, modes, sizes, link targets and content, read from the read-only mount,
never from `node`'s copy) in its own `0700` `/run/orkestrator-relay-state`, and
a mount whose digest is unchanged and whose copy is still there is left as it
is. Every other copy is removed and relayed again (or not at all, once the
mount is readable, gone or over the bounds), and with no copy kept the whole
relay directory is rebuilt, as it was before. `node` removes those copies,
opening up any directory a workload left without write permission; if a copy
still will not go, root rebuilds the whole relay rather than leave a stale copy
at its live path, and a copy whose relay fails and cannot be removed takes the
whole relay with it, so every input falls back to its unreadable mount. So the backend's rewrite of a
login or a revocation's scrub reaches the copy at the next start, and
revocation also removes the provider's relayed copies from the running
container (`stagedInputRelayPaths`), which the next start relays again only if
the mount still holds them. `node` owns its copy, so editing it changes only
its own input, as editing its home does. On a rootless
daemon an older image gets nothing readable: the backend logs it at creation
and the environment's inputs section says to rebuild (`unreadableOnRootless`,
`imageRelaysStagedInputs`).

Why a root-phase relay (decided 2026-10-26, todo 0109). `docker cp` of the
revision would put credentials in the container layer, where revocation
cannot empty them before the next start, and would have to be repeated on
every start. Writing the revision as the mapped UID (`unshare --map-auto`
and `chown`) needs `newuidmap` and a subordinate range on the backend host
and would leave the files unreadable to the backend's own user. The relay
keeps the bound revision as the single source, so revocation and login
renewal through `replaceStagedInputFile` keep working, changes nothing on
the host, and does nothing on a rootful daemon whose host user is UID 1000.
It is triggered by what `node` can read, not by the backend's topology flag,
so it needs no creation input a stale runtime could carry and also covers a
rootful host whose user is not UID 1000. The costs are a new image
(`staged-inputs=3`; an older image on rootless is flagged, not fixed), a
relayed copy in `/run` for the container's life, and the explicit removal
on revocation described above.

- Reading: the host home entry itself is resolved (a dotfiles manager may link
  it, and the bind mount it replaces followed that link); nothing below it is
  followed. Every file is opened `O_NOFOLLOW` and re-checked against the
  inode it was listed as. Sockets, devices and FIFOs are never inputs.
- Bounds, enforced while copying: 10 MiB per file, 5,000 entries and 256 MiB
  per directory unit, 20,000 entries and 512 MiB per revision. A skipped entry
  is counted by reason (`symlink`, `too-large`, `aggregate-budget`, …); names
  never leave the backend.
- Writing: on Linux a file staged byte for byte is reflinked from the
  descriptor that was checked (`FileCloner`, through `/proc/self/fd`), where
  the data directory's filesystem can (btrfs, XFS, bcachefs). A reflink shares
  the source's blocks until either side writes, so the revision stays an
  independent copy: a write to it never reaches the host file or another
  environment's revision, unlike a hard link. Its size is checked after the
  clone, against the same bounds. A login restricted after staging is cloned
  and then rewritten in place, which copy-on-write keeps local. A filtered or
  guarded file (Claude's settings and `.claude.json`, the credential-guarded
  skill and extension trees) is read and written as before, since cloning after
  the read could stage bytes nobody checked. Anywhere else (another platform,
  ext4, tmpfs, a source on another filesystem) the run copies, and after one
  failed clone from a source device it copies the rest from that device. On a 300 MiB plugin fixture on
  btrfs a revision took 162 ms and no new disk, against about 550 ms and 300 MiB
  copied (measurements (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)).
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
  revocation fences (the writer-lease holder only). Pi re-reads the file per
  request, and OpenCode's pushed logins are also written into the container
  server's database through its `/api/credential` route
  (`opencode2/container-credentials.ts`), which it reads per use, so a running
  session picks a renewal up; whether Grok's
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
  already had its copy removed by the account switch path. Claude's host login
  is removed at the next container start (`buildDropHostClaudeLoginCommand`):
  host copies go, a login the container made itself (`claudeAiOauth` or
  an `mcpOAuth` server) keeps its access token, and a file left with no login
  is deleted. An entry carrying any token whose SHA-256 the backend saw on the
  host for that slot (`HostClaudeTokenDigests`, in memory, handed to the drop,
  restrict and merge commands on stdin) is a host copy, refresh token or not.
  Otherwise a login the container made is one still holding a refresh token
  (a push never carries one) or, once stripped, one whose access-token SHA-256
  the strip recorded in `.credentials.json.orkestrator-owned`; the restrict
  and drop commands write that record before stripping, and the merge carries
  a recorded MCP login forward while the host's login has no entry for that
  server, so the login survives later starts and pushes. Every merge, restrict
  and drop writes the record, empty or not, so it also marks the container as
  tracked. In a container no pass has touched since the record existed, an
  older strip may have left the container's own logins access-only and
  unrecorded, so a drop there keeps (and records) every entry it cannot name
  as the host's: a host copy the backend never saw then stays until its access
  token expires or the next push replaces it, as before this removal existed.
  If `flock` or the locked pass fails, the drop falls back to the strip-only
  pass rather than deleting the file. The host reads as signed out
  (`hostClaudeSignedOut`) only when every place the login is looked up says
  so: each `.credentials.json` absent or holding no login, and on macOS a
  metadata-only `security find-generic-password` (no `-w`, so no access
  prompt) exiting 44, item not found, for each keychain searched. An
  unreadable file, an expired login or any other Keychain answer keeps the
  older behaviour, stripping refresh tokens in place.
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
  the running container's `~/.claude.json`. The refresh trigger is re-checked
  with a fake login on every Claude Code bump
  (`scripts/claude-host-refresh-trigger-probe.ts`, see
  [upgrading agents](../development/upgrade-agents.md#re-check-oauth-refresh-token-rotation));
  the live renewal checks with a real login are in the
  [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).
- Neither the Cursor key nor the Anthropic API key (when used instead of
  OAuth) is in a staged-inputs container's creation environment. The bridge
  reads the synced owner-only Cursor file. The Anthropic key is written to
  `/claude-config/.orkestrator-anthropic-key` in the staged revision, and
  `docker/runtime-env.sh` exports it into shells and agent processes, because
  Claude Code in terminals reads it from the process environment: it is
  visible to same-user processes, but not in `docker inspect`. Neither key
  goes in a new container's creation environment. A container created before
  staged inputs keeps the `-e ANTHROPIC_API_KEY` (and `CURSOR_API_KEY`) it was
  created with until it is rebuilt.
- No new container is created from an image without staged inputs (see
  [Rollout switches and legacy runtimes](#rollout-switches-and-legacy-runtimes)).
  A runtime created from one keeps its read-only home mounts until it is
  rebuilt; `get_environment_inputs` reports that as `host-mounts`, never as
  narrowed. It uses the cleanup review's evidence (`legacy-runtime-shape.ts`):
  no inputs-revision label *and* a bind at one of the old mount points. A
  runtime with no label and no such bind is `none`, and a failed inspect is
  `unknown`, never `host-mounts`. A `staged` revision that holds no provider
  and has nothing missing, disabled or revoked to report shows "Nothing was
  staged into this container." in the environment's inputs section
  (`EnvironmentInputsSection.tsx`), rather than an empty box.
- Credentials (staged inputs, the staged Anthropic key, the Cursor key and the
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

### Input stamps (`staged-inputs=5`)

The entrypoint used to copy every input into the home on every start. From
`staged-inputs=5`, `import_agent_input` in `docker/entrypoint.sh` skips an input
when copying it would change nothing. The result of a start is the same as a
full copy's, apart from the removal below.

- **What counts as unchanged.** A tree's content digests and listing match its
  stamp, and the home still holds those bytes at real paths, with no link at any
  listed file or directory. A single file only has to match the home byte for
  byte. So an edited or deleted import comes back, and a damaged or forged stamp
  can only cause a copy. The check reads contents because neither the revision
  name nor file times say what changed: the backend rewrites a revision in place
  (the logins before every start, a revocation's scrub, a refreshed MCP default)
  and the relay's `tar` keeps whole seconds.
- **Copying.** Anything else runs the same copy helpers as before, with the same
  bounds and link rules. A copy that warned is not stamped as complete, so it
  runs again and warns again. Ownership is recorded only after a helper succeeds;
  a refused entry never grants deletion authority over local files. Previously
  owned paths remain tracked across failed imports. If the tools fail, the input is copied.
- **Removal.** A stamp also lists the paths its input imported, so one that has
  left the mounts leaves the home: a file, a directory it emptied, or a whole
  provider's inputs after a revocation. Nothing else is removed, so a CLI's own
  files beside the imports stay. A path through a link or `..` is refused, and a
  mount `node` cannot open (a failed relay) removes nothing. Failed file removals
  warn and keep their ownership history so the next start retries them.
- **Logins** (`.credentials.json`, Codex's, Grok's, OpenCode's and Pi's
  `auth.json`) are never skipped, and go through `restrict_imported_login` on every
  start as before. Their stamp is a digest of the home's copy after the import. If
  the mount no longer has the login and the copy is still exactly that one, it is
  removed. A copy that differs was pushed by the backend or made in the container,
  and stays with the backend's own paths, which race the entrypoint and must keep
  winning. Claude startup cleanup, publication and digest attribution share an
  exclusive `flock` on `.credentials.json.orkestrator-lock` with both backend
  publication commands. The lock file stays in place so concurrent writers always
  lock the same inode. A Claude copy the backend pushed is left to the backend:
  after a host sign-out the next start removes it (see the host sign-out item
  under the access-only logins above).
- **Where it lives.** `~/.orkestrator-inputs`, mode `0700`, in the container
  layer, so a new runtime starts with a full copy. It holds names and digests,
  never contents. The workload can write it, so it is not a security boundary, and
  it does not need to be: the workload can already rewrite the imports themselves.
  A link there is replaced, never written through.
- **Older images** have no stamps and keep their full copy. The backend stages and
  binds the same either way, so there is no gate to check.

The entrypoint reports counts only (`Agent inputs: N unchanged, M copied`). The
relay in `network-policy-entrypoint.sh` skips an unchanged mount the same way
(see the relay above), and `copy_agent_directory` answers its entry bound, link
check and size bound (allocated blocks, what `du -sk` sums) and the stamp's
listing from one `find` walk, so a first start costs about five processes per
copied directory rather than about fifteen. The walk uses GNU find's `-printf`;
where find lacks it (BSD find, when the helpers run on macOS) the first walk
lists nothing and the rest of the boot uses a portable walk
(`agent_input_directory_walk`): `find -print0` classified with shell tests, and
one `du -sk`, with the same bounds and listing. Timings are in
[4580](../todo/containers-and-environments/4580-input-stamp-follow-ups.md) tasks 2
and 3 and [6740](../todo/containers-and-environments/6740-input-staging-follow-ups.md)
tasks 3 and 5; the earlier ones in to-do 1202, task 15 (retired 2026-11-10).

### Project seed files

The project folder's own `.env`, `.env.local` and `opencode.json` are copied
into every new container (`container-project-seed-files.ts`), where
`workspace-setup.sh` moves them into `/workspace`. They are repository
content, so a branch can commit any of them as a link to a host path, and
Docker resolves a bind source on the host (as root on a rootful daemon). They
are therefore never bind-mounted (security report H3):

- Before `docker create` the backend `lstat`s each one and reads it only when
  it is a regular file, not a link (even one to a file inside the project),
  whose `realpath` stays inside the project folder and which is at most 1 MiB.
  It is opened `O_NOFOLLOW | O_NONBLOCK` and must be the inode it listed.
- The bytes it read are what `docker cp` writes into the created, stopped
  container at `/project-env/<name>` and `/opencode-project-json`, owned by
  `node` (uid/gid 1000), `0600`, with a `0700` parent directory. An archive
  with explicit ownership is sent through `docker cp -a`, so delivery works
  even on images without the staged-input relay. Nothing re-reads the checkout.
- A refused file is skipped, never a failed environment. The refusal
  (`symlink`, `not-a-file`, `outside-project`, `too-large`,
  `changed-while-reading` or `unreadable`) is logged as
  `docker project-seed.refused`, recorded on the container as the
  `orkestrator-project-seed-refused` label (`name=reason` pairs), and printed
  as one `[orkestrator] Skipped …` line per file at the top of the setup
  terminal, before the setup's own "Setting up environment files" step. A
  rebuild re-reads and re-checks the files; a container that predates the
  label shows nothing.
- These three seed names are excluded from generic configured-file staging.
  A command-node fallback for a configured seed is read with the same rules,
  only when the project file is absent; a refusal never permits fallback.
  Other configured files still use `stageConfiguredProjectFilesForContainer`
  (realpath-confined, `docker cp` into `/project-files`).

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
29.9.2 with IPv6 on by default
([container qualification](../development/container-qualification.md#egress-gateway-conditions-on-linux-engine-2026-10-31)). The container also gets
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

Why copy the seed and classify the rest (decided 2026-10-26, todo 0109). The
GitHub ranges seed is the only single-file bind outside the input revision;
it is not a secret and nothing revokes it, so copying it in costs nothing a
bind gave. Staged-input file binds stay binds, because revocation empties
them in place. Any other refused remount is classified rather than worked
around, reusing `unsupported-topology` so older clients still parse it. The
start-time refusal pattern comes from the 2026-10-25 report and has not been
captured from a start; the 2026-11-09 rootless run captured the same refusal
from `docker cp`, which, with `docker cp` into a container that is not
running, is
[7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md).

Every start of a runtime, rebuild candidate or egress gateway goes through
`startDockerContainer` (`container-start.ts`). A read-only bind Docker refuses
to remount (`remount-ro … operation not permitted`) becomes an
`unsupported-topology` error naming the source and target. Rootless dockerd
picks an automatic host port inside RootlessKit's namespace, which cannot see
host listeners, so RootlessKit's bind on the host can collide (`address
already in use`); when the colliding port is not one the user fixed, the
start is retried, up to ten times (`PORT_COLLISION_RETRIES`): rootless
dockerd hands out automatic ports in sequence, and short-lived outbound
sockets held two in a row in a 2026-11-09 run, four in a row right after
a daemon restart on 2026-11-11, which hands ports out again from the bottom
of the range
([7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md)
task 4), and four in a row twice on a busy host the same day (7750
(retired)). Each retry is an inspect, a reconnect and a start with no
pause, and the run's length, retries, first and last ports and outcome are
logged once it ends (`start.port-collision-run`). Docker 29.9 detaches the
container from its network on each failed start, and a bare retry ran it
with no network and no published ports, so the helper connects the
container's own network again before every retry and stops it if the
started container still has none. A collision past the retries, or one on
a port the user fixed, is the existing `port-conflict`.

Each failed start moves rootless dockerd on by one port, so no retry count
gets past a held run longer than itself. On a rootless daemon the backend
therefore chooses every automatic host port itself when it creates a
runtime or gateway (`container-host-ports.ts`): it binds `127.0.0.1:0` on
the host, where the kernel sees every socket and prefers odd ports for
`bind` (outbound `connect` prefers even ones), publishes the result as a
fixed port and lists it in the `orkestrator-backend-host-ports` label. A
stopped container's ports hold no host socket, so the choice also refuses
the ports the same create fixes, the ports labelled on every container of
the same owner (`docker ps -a`) and, for the window before a new container
exists, the ports this backend chose in the last 30 minutes. The
port then stays the container's own across starts and daemon restarts. A
collision on a labelled port is retried on the same port after a pause
(1, 2 and 4 s, `PORT_HOLD_RETRY_DELAYS_MS`, so three same-port retries,
`PORT_HOLD_RETRIES`) for its short-lived holder to
go; one still held after the retries is a `port-conflict` that says to stop
the holder or rebuild the environment, which chooses new ports. A port the
user fixed is still never retried. Rootful daemons keep
Docker's own automatic ports, since they see the host's sockets, and a
container created before this keeps them until it is rebuilt.

The same rootless daemon refuses every `docker cp` into or out of a
container with a read-only bind whose source filesystem is mounted
`nosuid`/`nodev`, running or stopped, while start and `exec` work: the
daemon's archive path remounts the bind without the locked flags
(`remount-ro … flags: 0x1021: operation not permitted`). A refused copy is
classified (`docker-copy-refusal.ts`) rather than reported as a generic
failure: configured project files and project seed files fail creation
with `unsupported-topology` and the remedy (move Orkestrator's data
directory or run Docker rootful), a rebuild's copy step likewise, the
boot record read reports `boot-record-copy-refused` instead of
`container-exited`, and the best-effort GitHub seed logs
`refusal=read-only-bind-remount`. The CLI hides the daemon's answer for a
copy into a directory (`must be a directory`), so a failed copy asks once
more with a copy out of a path that cannot exist.

Those three copies into a created container go through `copyIntoContainer`,
which also handles a daemon that cannot mount the container's filesystem
because it is busy (`failed to mount … device or resource busy`, seen once,
on beelink2's rootless daemon on 2026-11-09, and not reproduced since,
[7549](../todo/containers-and-environments/7549-rootless-docker-cp-refusals.md)
task 2). It retries after 1 and 3 s (`COPY_BUSY_RETRY_DELAYS_MS`); a copy
still busy fails creation with `unsupported-topology` naming the busy
filesystem, and the GitHub seed logs `refusal=snapshot-busy`.

`live-restore` cannot work on a rootless daemon: a rootless restart replaces
RootlessKit, its user and network namespaces, containerd and the shims, so
the new daemon reports every container exited while the old containers'
processes keep running in the old namespaces with no network, on the same
volumes the restarted containers then mount (observed 2026-11-11,
[evidence](../development/container-qualification.md#rootless-daemon-restart-with-live-restore-and-on-gvisor-tap-vsock-and-the-7549-re-checks-2026-11-11)).
The backend starts those containers again as it does after any restart with
`live-restore` off, and cannot find or stop the orphans, so it warns once per
process when a rootless daemon reports `live-restore` on (`docker`
`daemon.rootless-live-restore`, from the capacity probe in
`container-resources.ts`); the remedy is `"live-restore": false` in that
daemon's `daemon.json`.

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
older images, and for runtimes created under the removed
`ORKESTRATOR_EGRESS=in-container` rollout cap, until they are rebuilt.
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

### Name checks (`egress-filter=1`)

A gateway on network policy 3 from an image that declares `egress-filter=1`
also checks the name a connection asks for (security finding M12):
`init-firewall.sh` starts `orkestrator-egress-filter` (a Perl daemon run by
the base system's `perl-base`) before any lookup, and installs, ahead of
Docker's own DNS rules:

- a DNAT of every new, unmarked TCP connection to an allowed tuple onto the
  daemon's port on the namespace's own address. The daemon reads the
  original destination, opens its own connection there and relays the
  client's bytes only once its first bytes ask for a name allowed on that
  port: the TLS ClientHello's server name, or the Host (and an absolute-form
  target) of a plain HTTP/1.x request. GitHub's own names are allowed on 443
  and 22 because its ranges are; `github.io` is not. A refused TLS client
  gets an `access_denied` alert, an HTTP client a 403 naming the gateway.
  Other protocols are refused on TCP 443 and relayed by address on any other
  named port; a server that speaks first (SSH, a database banner) is relayed
  to the client while its first bytes are awaited. A first write of
  printable text with no newline yet is held, because it could still become
  an HTTP request line sent a byte at a time; the daemon refuses it, with no
  reply, after 30 s. A client-first text protocol on a named port must
  therefore end its first command with a newline (SMTP, POP3, IMAP, Redis
  and memcached do); a bare word such as `probe`, or `{"op":1}`, is never
  relayed. Binary first bytes (TLS, PostgreSQL, MongoDB) are not held.
- a redirect of every unmarked DNS query, to Docker's resolver or straight
  to any server, to the daemon. It forwards an allowlisted name (exact),
  GitHub's names and `*.docker.internal` (only when asked through Docker's
  resolver) and answers anything else REFUSED, with Extended DNS Error 18
  when the query carried EDNS. A query sent to Docker's resolver goes back
  to it; one sent off-host goes to Docker's upstreams directly when Docker
  names them by address, so Docker's own relay from the namespace, which is
  redirected too, never loops.
- ACCEPT rules for TCP to the allowed set and for DNS to the resolvers that
  match only the daemon's `SO_MARK` (`0x6f726b`). The workload cannot set a
  mark (no `NET_ADMIN`, `NET_RAW` dropped). UDP entries stay address-only.

It fails closed: the boot fails (`state: failed`, no workload start) when the
daemon does not start, and a daemon that dies leaves redirected connections
refused and queries unanswered. Its supervisor restarts a dead worker within
a second, and the refresher restarts a dead supervisor. The boot's own
checks require a name off the list to be REFUSED and an allowed address to
refuse a foreign SNI before the report says `applied`.
`update-firewall.sh --set-domains` stages the proposed names for DNS lookups
while retaining the current connection permissions during resolution. A failed
rebuild restores the previous names without closing its streams. After a
successful rebuild, it publishes the final names and the daemon closes open
connections whose name left. DNS staging temporarily permits lookup of the
explicitly proposed names; it never grants their TCP connection permissions.
The next periodic refresh clears staging left by an interrupted edit.

The gateway records `egress-filter` (`on`, or `off` when the backend created
it with `ORKESTRATOR_EGRESS_FILTER=off`) once, at its first boot, and the
report carries `egressFilter` (`enforced`, `off`, `unavailable`), which the
Network section shows. A start or a read never changes it. A gateway from an
older image has no record and no field, reads as address-only enforcement,
and keeps it until it is rebuilt; an in-container firewall and full mode
never run it. The daemon listens on 31443 and 31453 in the shared namespace,
so a workload cannot listen there, and a connection to them that was not
redirected is refused.

The daemon counts what it refuses since the gateway booted: connections (a
name off the list in the ClientHello or Host, another protocol on TCP 443,
or a connection that never finished its first bytes) and DNS queries
answered REFUSED. It writes the two numbers to
`/run/orkestrator-firewall/egress-refusals.json` at most once a second when
one moved; a restarted worker carries them on, and a new boot (fresh `/run`)
starts at zero. The backend reads the file in the same `docker exec` as the
firewall report and returns it as `effective.refusals` only beside
`egressFilter: enforced` (`null` from an image before the counts), and the
Network section says how many were refused. While it shows the counts and
the window is visible, the section re-reads the policy every 15 s (one
`docker exec` in the gateway each time) and once more when the window becomes
visible again, so refusals made while it stays open appear without reopening
it; closing the section stops the reads. Nothing is pushed: the file has no
revision, and a watcher across the gateway boundary for one dialog's numbers
was not worth its cost. Counts only: no refused name,
part of one or digest of one is stored, logged or reported, because a refused
name can carry the data an agent tried to send (`<secret>.attacker.tld`).
`init-firewall.sh` holds `egress-filter.quiet` while its own boot checks ask
for names off the list, and the daemon does not count during it (a marker
older than two minutes is ignored, so one left by a script that died cannot
mute counting for long).

What it does not stop: a name hidden inside TLS (an encrypted ClientHello
whose outer name is allowed, domain fronting), a second request with another
Host on a kept-alive HTTP connection, an HTTP/2 connection a client reuses
for another name, UDP entries (QUIC), protocols other than TLS and HTTP on a
named port, and anything an allowed service accepts, such as a push to an
attacker's GitHub repository or a call with an attacker's API key. A
connection to an allowed address now completes its TCP handshake with the
daemon before the upstream answers, so an unreachable upstream shows as a
reset rather than a refusal.

These limits were decided, not overlooked (to-do 6102, retired 2026-11-11):

- Names inside TLS stay unseen. Seeing them needs TLS termination with a
  per-environment CA the workload must trust, which breaks pinned clients
  and hands the gateway every byte. Refusing any ClientHello that carries
  the ECH extension is not an option either: Chrome and Playwright send a
  GREASE ECH extension on every connection.
- Only the first request on a plain HTTP connection is checked. Checking
  every one needs body framing (chunked, `Content-Length`, upgrades) on the
  data path, for plain HTTP on a named port, which is rare and was answered
  by the same server.
- UDP entries and other protocols stay address-only. They are opt-in per
  port, and reading a QUIC Initial's SNI needs QUIC decryption in the daemon.
- A refused upstream stays a reset. Keeping it a refusal needs TPROXY with
  `IP_TRANSPARENT` and policy routing in the gateway, and clients treat both
  as a failed connection.

The workload's own `NET_ADMIN` and the `init-firewall.sh` sudo grant are
gone: every image now runs the firewall step from the root entrypoint before
privileges drop, and an in-container runtime gets `NET_ADMIN` only for that
firewall. `no-new-privileges` stays off: the image's entrypoint is `sudo
network-policy-entrypoint.sh` as `node`, which it would break, and starting
runtimes as root instead would make every `docker exec` default to root.

### Isolation constraints

These were decided while building network and credential isolation (to-do
0018, retired 2026-11-11) and should keep holding:

- Default ports: TCP 443 for allowed domains, TCP 443 and 22 for GitHub's
  ranges. Everything on the default lists is HTTPS on 443, so anything else
  needs a `host:port` (or `host:port/udp`) entry; plain HTTP (80) and SSH to
  other Git hosts are not defaults. Lists that relied on another port are not
  rewritten; the network status and settings help say what applies.
- Never claim that IP allowlisting prevents exfiltration. Shared CDN
  addresses, allowed services and DNS remain channels.
- Never fall back to the shared default bridge when the environment network
  cannot be created; that is an explicit error.
- No allow-all or empty window during a refresh: build the next set beside
  the live one, swap it in, then revoke tracked connections of removed
  entries.
- IPv6 stays dropped unless equivalent IPv6 enforcement is implemented and
  tested.
- Keep the restricted-mode sudo policy exact. Never add blanket sudo and never
  mount the Docker socket. Do not describe a root workload as unable to change
  its firewall unless its firewall runs in a gateway.
- Published ports stay on loopback and authenticated.
- A container never holds a refresh token it shares with the host or another
  container when that provider's refresh tokens are single-use or rotating. It
  gets the access token, re-read from the host on start, and signs out on its
  own when that expires. A refresh token that is reused rather than rotated
  (GitHub Copilot, Pi's Meta) may be copied, like an API key. Only the host
  refreshes, through the provider's own CLI; Orkestrator never calls a token
  endpoint or writes a host credential store itself, and an agent-test profile
  never refreshes the host. Which providers rotate is re-checked on every
  agent bump
  ([upgrading agents](../development/upgrade-agents.md#re-check-oauth-refresh-token-rotation)).
- Credentials go only to enabled, authorized, non-revoked providers.
  Revocation is recorded before anything else, so an interrupted revoke still
  gates staging and syncs. Never promise that removal retracts a credential a
  workload already read, and never revoke an account-wide key.

## Agent tools reachability (`container-host-reachability.ts`)

Container agents reach the backend's agent tools server (workflow results,
mail, tickets) at `http://host.docker.internal:<port>/mcp`. A host firewall
that drops Docker traffic (ufw's default policy on many Linux desktops) makes
those calls hang: a review stage used to idle until its result poll gave up.
For an admitted peer (see [Who may connect](#who-may-connect)), the server
answers any non-POST with 405 before authenticating, so a credential-free GET
that gets *any* HTTP status proves the path; a timeout, refusal or unresolved
name proves it broken. Three checks share one probe script and parser:

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
exact subnets. The fix is always one pasteable line: several subnets become
`sudo sh -c 'for net in ...; do ufw allow ... || exit 1; done'`, because
pasting one `sudo` line per rule lets the password prompt read the next line
as the password. Probe containers and the temporary network
carry the owner and `host-reachability-probe` role labels (not the `app`
label, so cleanup inventories never see them) and are removed after each
check; leftovers are reaped by the next one. Every step is logged with the
`[docker.reachability]` area, one `probe.result` or `check.probe` entry per probe. The
probe URL carries no credential. Commands: `get_container_host_reachability`,
`check_container_host_reachability`.

On a rootless daemon (`dockerRootless`) `host-gateway` names a bridge inside
RootlessKit's network namespace, where nothing of the host listens. When
those probes do not all answer, the check probes again through RootlessKit's
host loopback addresses (`ROOTLESSKIT_HOST_LOOPBACK_ADDRESSES`): slirp4netns's
`10.0.2.2`, then gvisor-tap-vsock's `10.0.2.1`, which `dockerd-rootless.sh`
falls back to on a host without slirp4netns, pasta or vpnkit. The daemon
refuses both unless it runs with
`DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false`. The first address
that answers on every probe network becomes the snapshot's `hostAddress`, and
new containers and gateways get `--add-host host.docker.internal:<address>`
(creation waits up to 45 s for the
first check, `resolveContainerHostAddress`), so the firewall's host-service
rule names it; the in-container alias repair before a bridge start uses it
too; an existing container whose alias already names either address keeps it
while no check has answered. If none answers, the verdict is `blocked` with a
rootless remediation instead of firewall rules, which cannot help: a systemd
drop-in for the user's Docker service and its cost (a Docker restart, and
every container of that daemon reaching the host's loopback services). It
names no address, since that depends on the network driver; the reachable
verdict's summary shows the one in use. The environment settings
network pane shows "Agent tools unavailable" for a container environment
while the verdict is `blocked` (`EnvironmentAgentToolsStatus`). Existing
gateway runtimes snapshot their host address at gateway boot and need a
rebuild after host loopback is enabled.

Why detect rather than configure (decided 2026-10-26, todo 0109). Orkestrator
never owns or restarts the user's daemon, and enabling host loopback lets
every container of that daemon reach every host loopback service, a security
trade only the user can make. Publishing the service back through a
container's forwarded port would need a multiplexing relay in every
container for one path, and the host's LAN address was tried live and
refused. `10.0.2.2` is the slirp4netns and VPNKit address; on the
gvisor-tap-vsock driver host loopback is `10.0.2.1`, which the check probes
and reports `reachable` (to-do 7548, retired 2026-11-10;
[evidence](../development/container-qualification.md#gvisor-tap-vsock-host-loopback-7548)),
and other drivers stay `blocked` with the same remediation.

### Port selection and the loopback address (`agent-tools-listen.ts`)

The server asks first for the port it used last time (saved by
`recordCapabilityPort`, so workflow-result capabilities and container
firewall rules survive a restart) and takes an ephemeral port when that one
is in use. Host agents are handed `http://127.0.0.1:<port>/mcp`, so the port
is only usable if `127.0.0.1:<port>` reaches this backend.

A wildcard bind does not prove that on macOS. BSD socket rules let
`0.0.0.0:<port>` succeed beside another process's `127.0.0.1:<port>`
listener, and the kernel then gives every loopback connection to the more
specific bind: host agents sent their bearer token to the other process and
got 401 (todo 7220, closed 2026-11-06; seen with a second `dev:test` backend that had taken the
saved port). `listenAgentTools` therefore:

- After a wildcard bind, also binds `127.0.0.1:<port>` with the same handler
  and peer gate, for the server's lifetime. On macOS that succeeds when the
  address is free and then stops any later process from taking it.
- When that bind is refused on Linux, keeps the wildcard listener: Linux's
  exclusive wildcard bind already owns loopback and prevents later takeover.
  Every other platform must acquire both listeners. A runtime overlap probe
  cannot safely establish exclusivity, because a competing process can win
  the probe's loopback port and produce the same `EADDRINUSE` as Linux.
  The port is released, `[docker.reachability] port.loopback-taken` is logged,
  and an ephemeral port is tried (up to three). The new port is saved, and
  containers follow it through the `host-service-ports` repair above.
- Treats an explicit `start(port)` as exact: a held loopback address fails the
  start with `EADDRINUSE` instead of moving.

Nothing is ever sent to the other process, and container reach
(`host.docker.internal`, the same port) and the peer gate below are
unchanged. A bind address that is not a wildcard (tests bind `127.0.0.1`)
gets one listener. Tests: `agent-tools-listen.test.ts` (both rule sets, and
the real kernel of whichever OS runs it; it also passed in a Linux container)
and `agent-tools-loopback-port.test.ts` (the saved-port clash through
`AgentToolsServer`).

Platform coverage: macOS and Linux were checked by those tests against the
real kernel (Linux in a container). Windows was not checked; the backend
refuses to start on `win32`, so the non-Linux branch is what would apply if
that ever changed, and its bind rules would need measuring first.

### Who may connect

The server listens on every host interface (`0.0.0.0`), because the host-side
address `host.docker.internal` reaches differs per daemon and per environment
network. Before anything is routed it decides on the peer address
(`agent-tools-peer-filter.ts`):

- **Admitted:** loopback (`127.0.0.0/8`, `::1`, mapped forms). On native rootful
  Linux Engine only, also any address inside an IPv4 subnet of the daemon's
  default `bridge` network or of a network labelled `orkestrator-owner=<this data directory's owner>`
  (environment networks and the reachability probe's network).
- **Refused:** everything else, including the LAN and a tailnet. The
  connection is closed with no bytes written: no 405, 404 or 401, so an
  outside peer cannot tell a route from a closed port. A peer the current
  list already refuses is closed on accept, before its request is read.

Non-Linux hosts use loopback-only admission without consulting Docker. On
Linux, each subnet refresh first reads `docker info`'s `OSType` and
`OperatingSystem`, and `SecurityOptions`. Docker Desktop and rootless daemons
use loopback only: VM and RootlessKit namespace ranges may overlap host LAN/VPN
addresses and cannot identify container peers on the host. Missing or malformed
security options on a non-Desktop daemon revoke subnet permissions. Changing
from rootful Engine to Desktop or rootless therefore clears any previous list.
A rootless peer arriving outside loopback stays refused. None has been seen:
through RootlessKit's host loopback (slirp4netns and gvisor-tap-vsock) every
container arrives as `127.0.0.1` (todos 6820 and 7548, 2026-11-09 and
2026-11-10), so rootless needs no topology-specific
permission.

The native Engine subnet list is read with `docker network ls --filter
label=orkestrator-owner=<owner>` and one `docker network inspect` per network
(at most 256 networks and 512 subnets). It follows network creation and
removal: `ensureEnvironmentNetwork`, `removeEnvironmentNetwork`, the probe
network's create and removal, the stale-probe reap and reviewed cleanup
report each change (`docker-network-changes.ts`), which marks the list stale
and reloads it at once. A request that arrives while a reload is running
waits for the entire refresh chain, including changes reported during a read.
Every non-loopback peer, including cached members, reloads the list once 15 s
have elapsed since the last read completed unless a change was reported, so a labelled network another process created
is admitted on its first call after that, and an outside peer costs at most
one Docker read per 15 s. A failed read revokes cached permissions until a
successful retry; retries remain rate-limited from completion, so slow reads
do not immediately expire. A network removed between listing and inspection
is omitted; other inspect failures invalidate the whole snapshot and log a
classified warning, as do list failures. Superseded reads cannot admit
a peer. HTTP parser errors close silently, and automatic Expect responses
are sent only after admission. The first
read happens on the first non-loopback peer, so a backend whose containers
arrive on loopback never reads Docker for this. Refusals are logged
(`[docker.reachability] peers.refused`) at most once a minute with a count.

The peer address a container's call arrives from, by topology:

| Topology | Peer seen by the server | Admitted by | Evidence |
| --- | --- | --- | --- |
| Docker Desktop (macOS) | `127.0.0.1`, for the default bridge, an environment network and an unowned network alike | Loopback | Run 2026-11-05 on Docker Desktop 4.98.0 (Engine 29.9.2, arm64) with `apps/backend/scripts/agent-tools-peer-evidence.ts` |
| Linux Engine (rootful) | The container's own address on its network (no NAT for traffic to a host address): `172.30.0.2` on the environment network, `10.213.0.2` on the default bridge; an unowned network's `172.30.1.2` is refused | The network's subnet | Run twice 2026-11-10 on beelink with the same script, inside the network namespace of `docker:disposable`'s nested rootful daemon (Engine 29.9.3, linux/amd64) on the host's rootful Engine 29.9.2; [todo 6820](../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 1 |
| Rootless, slirp4netns, host loopback on (`10.0.2.2`) | `127.0.0.1`, for the default bridge, an environment network and an unowned network alike | Loopback | Run 2026-11-09 on a disposable rootless daemon (Engine 29.9.2, RootlessKit 3.3.0, slirp4netns 1.3.3, linux/amd64) with the same script; [todo 6820](../todo/containers-and-environments/6820-agent-tools-peer-gate-linux-evidence.md) task 2 |
| Rootless, gvisor-tap-vsock, host loopback on (`10.0.2.1`) | `127.0.0.1`, for the default bridge, an environment network and an unowned network alike; `10.0.2.2` is unreachable | Loopback | Run 2026-11-10 on a disposable rootless daemon (Engine 29.9.2, RootlessKit 3.3.0, linux/amd64) with the same script; todo 7548, [evidence](../development/container-qualification.md#rootless-host-loopback-and-docker-cp-refusals-on-beelink-2026-11-10) |
| Rootless, `host-gateway` | Nothing: the gateway is RootlessKit's own bridge, which refuses the connection | — | Same runs; the host check then switches to whichever host loopback address answers |

On Docker Desktop no VM subnet grants admission. This means every container
on the daemon, owned or not, and every local process can still reach the port, as before; the token remains
the boundary there. What changed is that the host's LAN and tailnet addresses
no longer answer. A 2026-11-06 rerun with loopback-only Desktop admission
confirmed all three container sources still received 405 as `127.0.0.1`, the
environment probe and both host-check probes were reachable/405, and LAN and
tailnet calls closed without bytes. The permitted subnet list stayed empty
before and after removal, with zero leftover resources. The captured result
is `output/agent-testing/s0170-address/desktop-peer-evidence.json` (local,
git-ignored); it does not establish native Linux or rootless behavior.

On rootful Linux Engine (todo 6820 task 1, 2026-11-10) the admitted list was
the default bridge's and the environment network's subnets, and only the
default bridge's once the environment network was removed. Requests from the
daemon's host to its own addresses (its outer address and every bridge
gateway, `10.213.0.1` included) were closed with no bytes: each arrived from
the host's primary address (`172.17.0.2` there), outside every admitted
subnet. That fits Docker's per-bridge `MASQUERADE` rule (for the default
bridge, `-s 10.213.0.0/24 ! -o docker0`), which matches a local connection
sourced from a gateway address but leaving through `lo`. Without that rule
such a request would arrive from the gateway address and be admitted, which
would give a local process nothing it does not already have on loopback.

A host firewall is not part of this boundary. The gate refuses outside peers
whatever the firewall does, so whether a typical host's firewall would also
hide the port no longer decides anything (todo 6820 task 5, closed
2026-11-09). What stays visible without one is the instant open-then-close of
the TCP handshake: a LAN port scan sees the port as open, and every request
it sends is closed with no bytes. Binding per-gateway listeners instead, so
that nothing on the LAN accepts at all, was rejected because listeners would
have to follow network creation and removal and each port must be free on
every gateway. A firewall that drops Docker traffic (ufw's default incoming
policy) still matters for reachability, which is the check above.

The C22 live qualification case passes its scene's owner
to the filter, because its server's data directory differs from the one that
owns its environment network.

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
in [container-qualification.md](../development/container-qualification.md#workload-budgets-and-the-built-in-default-2026-10-25).

It is a preset capped at a fraction of the daemon's memory, not either alone.
The experiment's fixed preset (2 CPUs, 4 GiB, 1,024 PIDs) broke the heavy
browser workload on Docker Desktop with OOM kills, page crashes and failed
rounds, and a pure fraction would give a 32 GiB Linux host a 24 GiB
"budget" that contains nothing. The cap keeps one environment from
exhausting a small Desktop VM. The margin on Desktop's heavy-browser case is
thin (5,885 MiB peak against 5,888 MiB, with reclaim): a heavier browser
load would fail inside its own cgroup instead of taking the VM down. Long
agent sessions, providers other than Claude Code, and repositories larger
than this one were not measured. Rolling the default back is "No limits" in
Settings, or all-`null` limits on an environment.

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
| Container stdout/stderr | `local` driver, else `json-file`, 10 MiB × 3 (new runtimes) | `logDriverArguments` |
| Bridge/server output | 5 MiB × 3 per file, lines cut at the file size; 5 MiB, no rotation, without Perl or the writer | `orkestrator-log-writer` / `boundedBackgroundLaunch` |
| Previous run's bridge/server log | One file, up to 5 MiB, the active file at the last relaunch | `keepPreviousLogCommand` |
| Startup failure tail, `get_*_server_log` | 64 KiB and 200 lines | `boundedTailCommand` / `boundDiagnosticTail` |
| `get_container_logs` | ≤ 2,000 lines and 512 KiB | registry |
| Follow record | 16 KiB, UTF-8 decoded incrementally | `ContainerLogService` |
| Replay ring | 1 MiB and 2,000 records per source | `ContainerLogService` |
| Followers | one per container, 16 per backend, 5 s idle grace, 60 s lease | `ContainerLogService` |

Together these bound a runtime's diagnostic logs by construction, so nothing
measures them live. Six launch logs (the Claude, Codex, Cursor, Pi and Grok
bridges and the OpenCode server, the table in [The previous run](#the-previous-run))
each hold at most the active file, its `.1` and `.2` rotations and one
`.prev.log`: 4 × 5 MiB = 20 MiB, or 120 MiB for all six. Docker's own log
adds 10 MiB × 3, so a runtime holds at most about 150 MiB of diagnostic
output (plus the writer's dropped-line markers), and a rebuild discards the
`/tmp` copies. A live per-environment total would need a `docker exec` per
environment, the polling cost
[0020](../todo/containers-and-environments/0020-container-state-observation.md)
works to remove, so it is not built while the bound holds (to-do 0022
task 6, retired 2026-11-11). Revisit if a surface needs actual sizes, or when
another launch log is added, which also raises this bound.

Bridges and the OpenCode server start through `boundedBackgroundLaunch`: when
the image ships the writer, `setsid sh -c '<cmd> 2>&1 | orkestrator-log-writer
<file>'`. An image without the writer keeps the first 5 MiB through
`head -c` and drains the rest with `cat >/dev/null`, so its producer never
writes into a closed pipe; until 2026-11 it was an unbounded redirect. The writer owns the open file, so
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

The writer drops output rather than block: a failed open or write loses that
output, and a failed rotation loses the line that needed it. It counts the lost
lines and starts its next successful write with `[orkestrator-log-writer]
dropped N lines`, so a gap (a full disk, say) shows in the log itself; if the
file never becomes writable again, the marker never appears. Its size
accounting is not wound back for lost lines, so the next rotation, which frees
the oldest file, comes sooner rather than later. A custom image without Perl
appends up to 5 MiB less what the file already holds, drains the rest, and at
end of input appends `[orkestrator-log-writer] dropped at least N bytes past
<max>`. The notice has a fixed 128-byte allowance beyond the data cap; once
the file exceeds the cap, later runs drain without appending another notice.
These reach a container only when it is rebuilt.

Container stdout/stderr uses Docker's `local` driver where the daemon lists it,
else `json-file` with the same 10 MiB × 3 bounds, which overrides a daemon's
own default driver (`journald`, say) for these containers only. A daemon that
lists neither keeps its default and is warned about once per backend
(`docker` `log-driver.unbounded`); an empty list means the capacity probe
failed, so no driver is named rather than risk a failed create.

### The previous run

A relaunch used to delete the bridge log, so the log that explained a crash went
exactly when it was needed. Every launch script now runs `keepPreviousLogCommand`
first, which moves the log to its `.prev.log` name:

| Server | Active log | Previous run |
| --- | --- | --- |
| OpenCode | `/tmp/opencode2-serve.log` | `/tmp/opencode2-serve.prev.log` |
| Claude | `/tmp/claude-bridge.log` | `/tmp/claude-bridge.prev.log` |
| Codex | `/tmp/codex-bridge.log` | `/tmp/codex-bridge.prev.log` |
| Cursor | `/tmp/cursor-bridge.log` | `/tmp/cursor-bridge.prev.log` |
| Grok | `/tmp/grok-acp-bridge.log` | `/tmp/grok-acp-bridge.prev.log` |
| Pi | `/tmp/pi-bridge.log` | `/tmp/pi-bridge.prev.log` |

- **It works on every image.** The move is launch-script shell, not image content,
  so it applies at the next bridge start whichever image the container runs, with
  or without the rotating writer.
- **The new run's log starts clean,** so a startup failure's attached tail reads
  only that attempt. A rename keeps the file's 0600 mode.
- **Keeping output never stops a start.** The OpenCode script runs under `set -e`,
  so a first start with no log and a move that fails must both leave status 0. A
  failed move removes the log, as the relaunch always did.
- **An empty log moves nothing,** so a run that wrote nothing cannot displace the
  log of the crash before it. Otherwise only the last relaunch is kept: a run of
  relaunches leaves one previous log, and rotated `.1` and `.2` files are not moved.

`get_*_server_log` takes an optional `previous: true` to read that file, under the
same 64 KiB and 200 line bounds and the same redaction. Only an explicit `true`
selects it, a call without it reads the active log as before, and no previous log
reads as empty. The web client reads any of the six through
`getContainerServerLog(provider, containerId, { previous })`
(`apps/web/src/lib/backend/docker-skills.ts`); nothing in the UI calls it yet, and a
diagnostics export is the likely first consumer.

`open_container_logs` / `read_container_logs` / `close_container_logs` share
one `docker logs -f` per container among subscribers; a read renews the lease,
a cursor older than the ring or from another source returns an explicit `gap`,
and a replaced runtime is a new source id. Closing releases only the observer.
A lease that is not renewed lapses, so a client that never closes cannot leave
an immortal follower. Backend shutdown stops every follower.

## Claude terminal state signal (`claude-state-signal=3`)

Claude started in a container terminal reports its state through the hooks the
entrypoint writes into `~/.claude/settings.json`: `UserPromptSubmit` writes
`working`, `Stop` writes `waiting` and `StopFailure` (which runs instead of
`Stop` when a turn ends on an API error) writes `failed` to
`/tmp/.claude-state`. Bridge sessions
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
whole working-to-waiting turn between reads. A writer that cannot take the
lock within one second skips its write and still exits 0, so a hook never holds
up Claude; `ORKESTRATOR_STATE_LOCK_WAIT` (whole seconds) overrides the wait,
and only tests set it. The legacy state file is still
written for older backends. Reads are bounded to 256 bytes. Version 1 images
keep the one-second poll because their state cannot expose a missed whole turn.

Version 3 adds the `StopFailure` hook and the `failed` word (to-do 1200). It
bumps the revision but is not a completion, and the legacy file says `idle`
for it. The poll reads it as `idle` and persists it with
`completionOutcome: "failed"`, so storage rings `agent_failed` on the
`claude-terminal` source's own working edge, never "finished". When the poll
never saw that working edge (both rings lost from `waiting` or `idle`), the
changed revision alone records an `agent_failed` completion. Images with
version 2 have no `StopFailure` hook, so a failed turn there still reads
`working` until the next prompt; the poll arms the doorbell for any version
from 2. A backend that predates version 3 reads a `failed` snapshot as an
unreadable state and keeps the previous state (marked stale after three reads)
until the next prompt.

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
(`unarmed`, `arming`, `armed`, `unconfirmed`, `confirmed`, `demoted`,
`unsupported`), how many containers run the 1 s poll (`fallback`), lifetime
demotions by reason (`missed-change`, `rang-too-often`, `arm-failed`) and
accepted rings, in the `signals` block of recurring diagnostics
(`claude-state-signal`). It is content-free: no container id. The demotion log
line still names the container.

`unconfirmed` is a lineage that has stayed `armed` for a whole retry window
(5 min) since its first install with no ring, so its rings cannot reach the
backend: typically a host firewall that drops container traffic to the agent
tools port. The install's probe ring is fire-and-forget (the hook path must
never wait on the network), so this is the only place the backend can see it;
it cannot say why. A re-arm on the window keeps the lineage `unconfirmed`; a
ring confirms it and a demotion starts a new `armed` stretch. The worktree
signal and the claude-tmux hook doorbell report the same state the same way
(to-do 7080).

A poll is adopted for every running container, but it runs the 1 s cadence
only while the container can run terminal Claude: a terminal shell in it or a
claude-tmux tab of its environment (`terminalClaudeDemand`, re-evaluated by the
2 s reconciliation). Otherwise, after one read on adoption that settles any
stale stored state, it keeps the 30 s safety read even on an image without the
doorbell, since nothing in the container can write the state file (to-do 1202,
BG-7). A terminal or tab opening reads at once and returns to 1 s.

## claude-tmux hook doorbell (`tmux-hook-signal=1`)

A claude-tmux tab learns about hooks from files its hook script writes into
the session's `pending` and `timeout` directories. Its poll loop
(`TmuxSession.spawnPollLoop`) reads them, the transcript size, the expected
transcript (`<session id>.jsonl`, so an unbound tab binds without a search),
`tmux has-session` and, when due, the pane in **one** `docker exec`
(`pollSnapshotScript`). The pane is framed by a per-call nonce, because it is
the one section container output can fill with arbitrary text.

On an image with the capability, the container's hook script runs
`orkestrator-state-signal hook` after writing a hook file. That rings
`/tmux-hook-signal` with a per-container credential from its own config,
`/tmp/.orkestrator-tmux-hook-signal`, and writes no Claude state.
`TmuxHookSignalManager` (`tmux-hook-signal.ts`) arms it as the Claude state
signal is armed (capability check, host preparation, config from stdin, probe
ring) once per container, and a ring wakes every tab loop of that container.

| Tab state | Doorbell confirmed | Cadence |
| --- | --- | --- |
| Busy, or within eight quiet ticks of activity | either | one snapshot every 250 ms |
| Idle | no (older image, unarmed, demoted) | one snapshot a second; liveness every other one |
| Idle | yes | a ring reads at once; otherwise one safety snapshot every 2.5 s with liveness and the pane (`TMUX_SIGNALLED_IDLE_INTERVAL_MS`) |

A ring only ends a wait early, and a woken loop still keeps 250 ms after its
previous read, so a container can never cause more reads than the per-tick
poll. A safety read that finds a hook file no ring announced, with still no
ring by the next read, revokes the credential (`missed-change`); the container
is armed again after 5 min. Diagnostics report it as the `tmux-hook-signal`
signal source. Host tabs have no doorbell (their listings are syscalls).

Measured with `apps/backend/scripts/tmux-exec-count.ts` (the real loop against
a fake container, 600 simulated seconds per tab): idle 1.85 execs/s before,
1.01/s on an older image and 0.42/s with the doorbell; unbound idle 2.57/s,
1.12/s and 0.52/s; busy 6.50/s and 4.00/s.
`apps/backend/tests/tmux-hook-signal-docker.test.ts` proves the image side and
counts a real idle tab with its transcript bound: 4 execs in 10 s.

## Project Git mirror

A new container environment clones from a bare mirror of its project instead of
downloading the repository again (`project-git-mirror.ts`,
`clone_from_git_mirror` in `docker/workspace-setup.sh`). Image capability
`git-mirror=1`. An image without it gets neither the mount nor the variable, and
clones as it always did. A runtime over an existing checkout (a rebuild or a
restored copy, `reusesWorkspace`) never clones, so it gets neither.

The mirror is a cache: **nothing depends on it**. A missing, stale, locked or
corrupt mirror never stops an environment starting, and an environment does not
need it once cloned.

| Path | Holds |
| --- | --- |
| `<data>/git-mirrors/<project id>/mount-<kind>/` | A bind source per access kind (authenticated readers add a random UUID suffix) (`anonymous`, `github-pat`, `github-host-cli`), mounted read-only at `/orkestrator-git-mirror` with `-v` into the containers given that access |
| `.../mount-<kind>/mirror.git` | That kind's mirror. Appears only by rename, once complete. `ORKESTRATOR_GIT_MIRROR` names it. At most one kind holds one |
| `.../mount/` | The single bind source from before access kinds. Kept, empty, because stopped containers still name it; its mirror is retired by the first refresh |
| `.../state.json` | Last attempt, consecutive failures, remote hash, the access kind and GitHub login the live mirror was fetched with, oversized and suspect marks. Outside the mounts, so a container cannot read it |
| `.../.building-*`, `.../.retired-*` | Scratch for a build, a fetch's empty home and what a refresh replaces or withdraws, removed by the same refresh or the next |

- **The clone.** The setup script checks the mirror cheaply (the directory exists,
  its refs can be read, the tip's tree is present), then runs `git clone --no-tags
  --reference-if-able <mirror> --dissociate <url>`. The remote is contacted for its refs
  and for anything the mirror lacks, so `origin` is still the project's remote and
  a stale mirror costs only the difference. `--dissociate` copies what the clone
  needs and drops the link, so the result is self-contained. `--dissociate` walks
  the history, so a clone also fails on damage the check cannot see.
- **No `--filter` with a mirror.** `--dissociate` in a partial clone keeps only
  what it does not attribute to the promisor remote. With a mirror behind the
  remote, it dropped the history the mirror held (31,276 objects missing on
  `git/git`) and fetched it back from the remote on demand. A blobless clone also
  pays for history reads one lazy fetch at a time; see
  the measurements (to-do 1202, retired 2026-11-10).
- **`--reference-if-able`, checked again afterwards.** A mirror removed between
  the check and the clone does not fail the clone: Git clones from the remote
  alone, with the full history. The script then checks the mirror again and, if
  it has gone, reports `vanished` instead of `used`, so that download is logged
  (`git-mirror.clone-fallback`) rather than passing as a mirror clone. A mirror
  that disappears part-way through `--dissociate` still fails the clone
  (`clone-failed`) and falls back as below.
- **Fallback.** Anything else leaves the ordinary clone (blobless, then full) to
  run as it always did, after one line saying why, with one fixed reason word:
  `missing`, `empty`, `corrupt`, `clone-failed` or `not-self-contained`
  (`vanished` keeps the clone it already made and does not fall back). The line
  goes to the setup output, and `prepareContainerWorkspace`'s caller logs it
  (`git-mirror.clone-fallback`, `git-mirror.clone-used`). The first environment of
  a project normally reports `missing`. The last three mark the mirror suspect, so
  the next refresh runs `git fsck --connectivity-only` and rebuilds it if that
  fails.
- **Refresh.** `createDockerContainer` starts one in the background when it gives
  a container the mount, at most every 15 minutes per project, and never waits for
  it. So a first environment still downloads, and the mirror builds beside it; the
  second environment is the first to benefit. There is no timer: an idle project
  makes no network requests. Only branches are fetched: clones use `--no-tags`, and
  `refs/pull/*` can dwarf a repository.
- **Seed.** A build, not an update, starts from the host checkout at
  `project.localPath` when it has one (`seedMirror`), so the build downloads only
  what the checkout lacks. The checkout can hold unpushed work, and its refs and
  config are shaped by whatever ran in it, so it decides nothing:
  - It is read only by a fetch of its `refs/remotes/*`, through `upload-pack`,
    which restricts what a repository's config and hooks can run. Local branches
    stay behind. `GIT_ALLOW_PROTOCOL=file` and `GIT_NO_LAZY_FETCH=1` stop an older
    Git following a partial clone's promisor. Objects are hashed on the way in,
    and the fetch checks each ref's whole history.
  - That goes into a quarantine, `.building-*/seed.git`, outside the mount. The
    remote is then fetched into it, so the remote says which branches exist and
    where they point, and sends what it finds missing. A ref it does not recognise
    only wastes a negotiation round.
  - The mirror fetches `refs/heads/*` from the quarantine, so it receives what the
    remote's branches reach and no other ref or object.

  Anything else (no checkout, an unusable, damaged, shallow or partial one, more
  in it than the size limit, or too little disk for the quarantine) discards the
  seed and downloads as before. A remote that cannot be reached fails the build:
  a checkout never makes a mirror on its own. The seed reads the checkout as the
  backend's user, so what `upload-pack` still allows is the remaining exposure:
  Git calls its attack surface large. A host agent running as that user gains
  nothing from it, and a container is not given the checkout: it gets a clone
  and copied seed files, not a bind of `localPath`.
- **Writers.** One refresh per mirror in a backend; a launch during a refresh joins
  it. A second backend on the same data directory holds no writer lease, so it
  creates no containers. Readers need no lock: Git publishes a pack before the refs
  that reach it, compaction keeps old packs until new ones exist, and a build is a
  rename. Three fetch failures in a row (a lock left by a crash, say) rebuild the
  mirror rather than update it.
- **Restricted containers.** A restricted container gets the mount only when its
  firewall would let it reach the remote itself (`restrictedContainerReachesGitRemote`):
  the host its clone connects to after `convert_ssh_to_https`, on GitHub's
  always-open TCP 443 or an allowlist entry for that host and port (any port
  under a network policy before 3). Otherwise it is withheld
  (`git-mirror.mount-withheld`, reason `remote-unreachable`) and the clone goes to
  the remote as before, so the mirror never hands it what its firewall would not.
  A runtime that already mounts the mirror requires a rebuild when an allowlist
  revision (including inherited global changes) blocks its original clone remote.
  Other edits apply live on capable images, including unrelated domain removals
  for GitHub projects. The runtime's `GIT_URL` supplies the original remote; a
  missing or unrecognised URL conservatively requires rebuilding. When remote
  access would be revoked, the status and apply routes report `rebuild-required`
  and retain the previous firewall policy until then: changing the firewall
  alone cannot revoke a bind mount. Other environments'
  shared mirror is never removed to revoke one reader. Rebuilt runtimes that
  reuse their checkout have no mirror mount and can apply later edits live.
- **Access.** A container reads through the mount only what its own
  credential could fetch (`project-git-mirror-access.ts`). Containers get a
  GitHub token only when Settings chooses one (`containerGitHubCredential`,
  `none` by default), only for `https://github.com`, and nothing for other
  hosts. So `createDockerContainer` resolves the access a new container is
  given (`resolveGitMirrorAccess`): `github-pat` or `github-host-cli` when the
  remote, as the container's clone converts it, is GitHub over HTTPS and
  `resolveContainerGitHubToken` returns a token; otherwise `anonymous`, which
  is also every agent-test profile's, since those never sync a credential in.
  Anonymous containers use `mount-anonymous/`. Authenticated containers receive no mirror
  mount and schedule no mirror refresh: a fresh authenticated generation cannot help
  its initial clone, and a background download would be wasted. They clone directly
  with their runtime credential. This also removes the need to coordinate a token
  snapshot between mirror selection and credential delivery.
  - **The fetch is the container's.** The URL converted as
    `convert_ssh_to_https` converts it, `GIT_ALLOW_PROTOCOL` limited to its
    scheme (`file` only for the agent-test fixture, which the container
    reaches through its own bind), `GIT_CONFIG_GLOBAL=/dev/null`,
    `GIT_CONFIG_NOSYSTEM=1`, no `GIT_*` variable, `GH_TOKEN`, `GITHUB_TOKEN`
    or `SSH_ASKPASS` of the backend's, an empty `HOME` per fetch (libcurl
    reads `~/.netrc`), `credential.helper=` and, for a GitHub kind, the
    `https://github.com` helper fed that kind's token by environment. The
    host's credential helpers, `.netrc`, askpass, SSH keys and Git settings
    such as `http.proxy` therefore play no part; proxy variables still do. A
    private repository under `anonymous` gets no mirror, which matches its
    container's clone failing anyway; a public one keeps the mirror under the
    default `none`. The backend's own GitHub credential is never used.
  - **One live mirror.** Every refresh first retires the mirror of every other
    kind, and the legacy `mount/mirror.git`, keeping their directories for
    stopped containers' `-v`. A container whose access no longer matches what
    containers are given finds an empty mount and clones from the remote. A
    change of kind (recorded in `state.json`) rebuilds at once, inside the
    refresh interval (`git-mirror.access-changed`).
  - **The same setting, another account.** A token can act as another account
    under an unchanged setting (another `gh auth login`, a new PAT). Each
    refresh with a token reads its login with `gh api user`
    (`getGitHubTokenLogin`) and keeps it, lower-cased, in `state.json`. The
    login is not secret; no token or token-derived value is stored. A
    different login withdraws the mirror before fetching and rebuilds it. A
    login that cannot be read (no `gh`, no network, a refused token) withdraws
    the mirror too, without bypassing the interval, and records `null`, so the
    next refresh builds it anew with the current token.
  - **Historical authenticated mounts.** Before runtime credential synchronization
    (including restart and token propagation), the backend cancels and drains the
    project's active mirror writer, then withdraws every authenticated and legacy
    mirror. Bind directories remain for existing containers, but are empty before
    the token is replaced or removed. A withdrawal failure prevents credential
    synchronization. Anonymous mirrors contain only anonymously fetched objects
    and remain safe through credential changes.
  - **Retry bounds.** The lower-level authenticated refresh path retains its
    oversized and attempt deadlines across fresh reader generations when access
    kind and account are unchanged. A generation changes publication, not retry
    eligibility. New production containers do not use this path.
  - **Access transitions during refresh.** A different access request aborts
    the active writer and queues the latest request. The writer settles before
    the queued reconciliation runs; shutdown also drains it without restarting.
  - **Refused seeds.** Before copying checkout objects, the isolated remote
    access is probed with `ls-remote`. A refusal ends the attempt without a
    seed copy or fallback fetch; normal failed-attempt backoff applies.

- **Credentials at rest.** The URL and any credential are passed per transfer,
  and no `remote` section exists, so the config holds neither;
  `--no-write-fetch-head` keeps the URL out of `FETCH_HEAD`. A container
  fetches with its own credential, as before, and cannot write to the mirror.
- **Read-only and readable.** The bind is `:ro`, for root in the container too.
  Files are `0644` and directories `0755` (`core.sharedRepository`), because under
  rootless Docker the workload user is not the backend's user; `<data>/git-mirrors`
  and the project directory are `0700`, so no other host user gets that far. Git
  allows the foreign owner because everything uses an explicit `--git-dir`. Every
  environment of a project given the same access can read every branch that
  access fetches through the mount; a branch deleted on the remote leaves at the
  next refresh, and its objects at a later compaction.
- **`-v`, not `--mount`.** Docker refuses to start a container whose `--mount`
  source is gone. With `-v` it recreates the source, so a stopped environment
  survives its mirror being removed by any route. If the project parent was
  removed too, rootful Docker can recreate it as root: automatic rebuild and
  cleanup then require host ownership repair. For manual cache reclamation,
  remove only `mount-<kind>/mirror.git`; see the
  [ownership recovery instructions](../development/disk-usage.md#project-git-mirrors).
- **Removal.** `cleanupProjectForRemoval` stops any refresh and removes the
  project's directory; a failure is logged and never blocks removing the project.
  `sweepOrphanedProjectGitMirrors`, in the admitted pre-ledger sweep, removes
  whatever that left. A refresh removes its own mirror when the repository passes
  the limit. Nothing else removes one. Bounds and disk cost are in
  [disk-usage.md](../development/disk-usage.md#project-git-mirrors).

Qualified by `tests/unit/workspace-setup-git-mirror.test.ts` (the script against
real repositories), `project-git-mirror.integration.test.ts` (build, refresh,
credentials, access kinds and accounts, concurrency, removal; a private remote
over smart HTTP that the host's helper, `.netrc` and askpass each open is
refused to the mirror), `project-git-mirror-access.test.ts` (which access a
container is given, the fetch environment, the login read through a fake `gh`),
`project-git-mirror-create.test.ts` (the kind a `docker create` binds) and, in
real containers,
`project-git-mirror-docker.test.ts` (read-only mount, foreign owner, removal, a
restart with the source gone).

Not yet qualified:

- A real rootless daemon. The mirror is world-readable inside an owner-only
  directory for that case, and a clone as `--user 12345` passes, but the mount was
  not run under rootless Docker, where a daemon recreating a removed source does
  so as the host user rather than root.
- Docker Desktop. Bind mounts there go through its file sharing, so the clone time
  is likely to differ, and whether the data directory is shared by default was not
  checked.
- A restricted network. The measurements used the default bridge with
  `NETWORK_MODE=full`. The clone still reaches the remote for its refs, through the
  same allowlist as before, but this was not run behind a firewall.
- A real-stack `dev:test` profile with a freshly built image. The live test binds
  this checkout's script over an older image's copy and calls the mirror functions
  directly, so the image's own capability probe and `createDockerContainer` were
  not run together against real Docker.
- A seed against a real network remote. It was measured against a local bare clone
  (see [disk-usage.md](../development/disk-usage.md#project-git-mirrors)).
- A GitHub kind against github.com. The token helper, the login read and an
  account change were run against a local remote and a fake `gh`, not with a
  real container token, a real `gh api user` or a real private repository.

## Container lifecycle events

The backend's `docker events` follower (`container-oom-events.ts`) reports
`start`, `die`, `stop` and `destroy` for its own containers. Each event
invalidates the shared `docker ps` snapshot, and `ContainerLifecycleReactor`
(`container-lifecycle-events.ts`) acts on it:

- On `die`, `stop` or `destroy`, the loops keyed by the container retire at
  once: its Claude state poll and tmux hook doorbell, and every tmux tab in it,
  which checks liveness on its next read and leaves through its stopped path.
- Unless a lifecycle operation owns the environment, its stored status is
  reconciled with one `docker inspect` (`syncStoredEnvironmentStatus`), then
  the diff and PR loops and the Claude state polls reconcile against storage.
  A start outside the app re-adopts them the same way.

Events for one container coalesce, so a `die`/`stop`/`destroy` burst
reconciles at most twice. A replayed event after a follower restart is a
second reconciliation and nothing more.

## Bridge credential (`bridge-credential=1`)

A bridge shares the agent's uid, so it holds no secret: the backend gives it the
SHA-256 of its token and keeps the token where only root in the container can
read it (`container-bridge-credential.ts`). The rules for bridges are in
[`bridges/AGENTS.md`](../../bridges/AGENTS.md).

| Where | What it holds | Who reads it |
| --- | --- | --- |
| `/run/orkestrator-bridge/<kind>-token`, 0600 in a 0700 root directory | The token | The backend, with a root exec |
| `/run/orkestrator-bridge/<kind>-authority`, beside it (`bridge-launch=1`) | The private half of the bridge's authority key | The backend, in the same root exec |
| `/run/orkestrator-bridge/opencode2-listener` (`opencode2-launch=1`) | The inode of the socket the OpenCode server the backend launched listens on | The backend, in the root exec that reads OpenCode's password |
| `/run/orkestrator-opencode2` (`opencode2-launch=1`) | OpenCode's configuration directory, empty XDG and home directories and package cache: the user's host configuration and Orkestrator's plugins, rebuilt as root before every start | The OpenCode server, read-only |
| The bridge's environment | `<TOKEN_ENV>_SHA256` and, with `bridge-launch=1`, `<TOKEN_ENV>_AUTHORITY_KEY`, both removed from `process.env` at start | Anything, harmlessly |
| The bridge's memory | The token, briefly, on each request | Nobody: the bridge is non-dumpable, so `/proc/<pid>/{environ,mem,fd}` belong to root and a same-uid ptrace is refused |

- **Nothing reaches `docker exec` argv.** The root file is written on stdin. What
  a start script still needs as a secret (the agent-tools token, and a plain token
  on an older image) goes on stdin to a mode 600 file that the script sources and
  deletes first (`launchContainerScript`). `docker exec -d` has no stdin of its
  own, hence the separate exec.
- **The bridge entrypoint bypasses checkout Bun configuration.** The bridge
  runs from root-owned `/opt` with `bun --config=/dev/null`. On a
  `bridge-launch=1` image the root-owned `orkestrator-bridge-launch` starts it
  under `env -i` from the backend's own exec, so nothing in the `node` login
  shell (a profile, the runtime snapshot, `BUN_OPTIONS`) runs inside it; the
  bridge hands the start script's environment to the agents it spawns
  ([agent-approvals.md](agent-approvals.md#fixed-launch-bridge-launch1)). This
  does not prevent SDK resource loading: when project resources are enabled,
  Pi discovers project extensions and executes them in the bridge process,
  where such code can observe later presented credentials. Pi therefore excludes discovered extensions and configured packages under
  every policy, preventing persistent hooks from affecting later ask sessions
  ([agent-approvals.md](agent-approvals.md#code-a-bridge-loads-itself)).
- **What changes an agent's authority is signed.** On a `bridge-launch=1` image
  every mutating request except close, the activity batch and the log policy
  carries the backend's Ed25519 signature, so a token caught in flight answers
  nothing ([agent-approvals.md](agent-approvals.md#signed-authority)).
- **Root never reads a `node`-writable path.** `readContainerBridgeToken` reads the
  root file as root, and only then the old `/tmp` file as `node`, because `node` can
  make that a symlink to anything.
- **An older image keeps what it had.** A container whose image lacks the capability
  keeps a `node`-readable token in `/tmp` and in
  the bridge's environment until it is rebuilt. Tokens still reach it on stdin, and
  a bridge an older backend started keeps working unprefixed
  ([version-compatibility.md](version-compatibility.md#register)). Missing recorded
  image ids are resolved by inspecting the running container. An unreadable image
  manifest refuses fresh startup rather than silently selecting weaker storage;
  retry after Docker can read the image. Healthy existing bridges reuse their token.
- **A live session's execution policy only narrows.** Every bridge refuses a
  request that would widen a live conversation's policy with 403
  `policy-widening-refused` (`packages/protocol/src/execution-policy-narrowing.ts`).
  A session restored from disk keeps its saved policy under an in-memory
  `policyPending` marker: the next policy a request sends replaces it, and the
  marker clears once a request sets one or a prompt starts. When the user widens
  a policy, the backend replaces the bridge and resumes
  (`replaceBridgeForWiderPolicy` in `native-agent-service.ts`), and refuses while
  a turn is running in that environment. `readOnly` stays a per-turn intent;
  that is safe only because the backend alone holds the bridge token and, on a
  `bridge-launch=1` image, signs the turn. A separate uid for the bridge was not
  built: the token is already out of the agent's reach, and what the shared uid
  still allows is in [agent-approvals.md](agent-approvals.md).

What the agent's uid can still do is in
[agent-approvals.md](agent-approvals.md#what-the-agents-uid-can-still-do):
kill the bridge, or replace it between two of the backend's checks of the
socket on its port ([a replaced bridge is refused](agent-approvals.md#a-replaced-bridge-is-refused)),
and on an older image catch the token on the bridge's port or plant code for the
next start. OpenCode has no bridge and takes the plain password. Its server
(`opencode2-container-server.ts`, container port 4102) keeps it in
`opencode2-token` in the same directory and in its own environment alone; on
an `opencode2-launch=1` image the launcher starts it from root's binary and
configuration and the backend sends the password only to the listening socket
it recorded in `opencode2-listener`
([agent-approvals.md](agent-approvals.md#opencode-under-the-launcher-opencode-launch1),
and the package cache and project configuration
[on `opencode2-launch=1` images](agent-approvals.md#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1)).
A plugin inside the server (`buildOpenCode2CredentialPluginSource` in
`opencode2/server.ts`, with `hardened: "refuse-tools"` in a container) removes
it from the process and every shell, marks the server non-dumpable and
refuses tools when it cannot. A host server gets the plugin from the
configuration directory Orkestrator gives it (`opencode2/host-launch.ts`). An
image that keeps no root credential file is refused rather than given a
`node`-readable one; every image that carries `opencode2` has one. The 1.x
server's `opencode-token`, `opencode-listener` and `/run/orkestrator-opencode`
were retired with 1.x on 2026-11-11.
Qualified by `apps/backend/tests/bridge-credential-docker.test.ts`.

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
